import type { Db, DbEntry } from "@statewalker/db-api";
import { hasReadOnlyTransaction, inReadOnlyTransaction } from "@statewalker/db-sqlite";
import { DbRpcError } from "./errors.js";
import { toPages } from "./pages.js";
import type { DbRpc, QueryOptions, QueryPage, QueryResult, RequestOptions } from "./types.js";

export interface DbRpcServerOptions {
  /** The Db served. The server never closes it: its owner does. */
  db: Db;
  /**
   * Run every call in a transaction that is always rolled back (`inReadOnlyTransaction` from
   * `@statewalker/db-sqlite`): reads see the data, writes answer inside their call and never
   * persist. Needs a `@statewalker/db-sqlite*` Db.
   */
  readOnly?: boolean;
  /** Rows per page at most (default 1024). */
  pageRows?: number;
  /** About how many bytes a page holds at most (default 256 KiB); a larger row goes alone. */
  pageBytes?: number;
  /** A result not read for this long is dropped, and a kept answer forgotten (default 2 min). */
  idleTimeout?: number;
  /** Results of more than one page kept open at most (default 256). */
  maxStreams?: number;
  /** Answers kept by `streamId` or `requestId` at most (default 256; oldest settled dropped). */
  maxRequests?: number;
  /** Sweep idle results every this many ms. Without it, every `query` sweeps. */
  sweepInterval?: number;
  /** The clock (tests). Default `Date.now`. */
  now?: () => number;
}

export interface DbRpcServer extends DbRpc {
  /** Drops idle results and forgotten answers; returns how many results it dropped. */
  sweep(): number;
  /** How many results are open. */
  openStreams(): number;
  /** Drops every result, stops the sweep timer and refuses later calls (`ABORTED`). */
  close(): Promise<void>;
}

/** 16 to 128 characters of [A-Za-z0-9_-]: the form of a caller-chosen stream or request id. */
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const BAD_KEY = "an id is 16 to 128 characters of [A-Za-z0-9_-]";

const newKey = () => crypto.randomUUID().replace(/-/g, "");

/** Serves a Db as plain calls (see {@link DbRpc}). */
export function newDbRpcServer(options: DbRpcServerOptions): DbRpcServer {
  const { db } = options;
  const readOnly = options.readOnly === true;
  if (readOnly && !hasReadOnlyTransaction(db)) {
    throw new TypeError(
      "db-rpc: a read-only server needs a Db that can roll back a read-only transaction " +
        "(a @statewalker/db-sqlite* Db, not wrapped)",
    );
  }
  const pageRows = Math.max(1, options.pageRows ?? 1024);
  const pageBytes = Math.max(1, options.pageBytes ?? 256 * 1024);
  const idleTimeout = options.idleTimeout ?? 2 * 60_000;
  const maxStreams = Math.max(1, options.maxStreams ?? 256);
  const maxRequests = Math.max(1, options.maxRequests ?? 256);
  const now = options.now ?? Date.now;

  /** Runs `fn` on the Db, or, read-only, inside a transaction that is always rolled back. */
  const run = <T>(fn: (target: Db) => Promise<T>): Promise<T> =>
    readOnly ? inReadOnlyTransaction(db, fn) : fn(db);

  let closed = false;
  const live = () => {
    if (closed) throw new DbRpcError("ABORTED", "the server is closed");
  };

  /** Open results of more than one page. */
  const streams = new Map<string, { pages: DbEntry[][]; touched: number }>();
  /** Queries running now: they hold a place among `maxStreams` until they know their size. */
  let starting = 0;

  /** Answers by method and id, oldest first. */
  const answers = new Map<string, { at: number; settled: boolean; answer: Promise<unknown> }>();
  /** Runs `call` once per id (within idleTimeout): a call delivered again gets its answer. */
  const once = <T>(method: string, id: string | undefined, call: () => Promise<T>) => {
    if (id === undefined) return call();
    const key = `${method} ${id}`;
    const kept = answers.get(key);
    if (kept) return kept.answer as Promise<T>;
    const answer = call();
    answer.catch(() => {});
    const entry = { at: now(), settled: false, answer };
    answers.set(key, entry);
    const settle = () => {
      entry.at = now();
      entry.settled = true;
    };
    void answer.then(settle, settle);
    // Past the cap the oldest settled answer goes: forgetting a running call would let a retry
    // run it again. Only when every call is running does the oldest of them go.
    while (answers.size > maxRequests) {
      let victim: string | undefined;
      for (const [k, a] of answers)
        if (a.settled) {
          victim = k;
          break;
        }
      answers.delete(victim ?? (answers.keys().next().value as string));
    }
    return answer;
  };

  const checkKey = (id: unknown): string | undefined => {
    if (id === undefined) return undefined;
    if (typeof id !== "string" || !KEY.test(id)) throw new DbRpcError("INVALID", BAD_KEY);
    return id;
  };

  const sweep = (): number => {
    const t = now();
    let dropped = 0;
    for (const [id, s] of streams)
      if (t - s.touched >= idleTimeout) {
        streams.delete(id);
        dropped++;
      }
    for (const [k, a] of answers) if (a.settled && t - a.at >= idleTimeout) answers.delete(k);
    return dropped;
  };

  const timer =
    options.sweepInterval && options.sweepInterval > 0
      ? setInterval(sweep, options.sweepInterval)
      : undefined;
  (timer as { unref?: () => void } | undefined)?.unref?.();

  const server: DbRpcServer = {
    async query(sql: string, params?: unknown[], opts?: QueryOptions): Promise<QueryResult> {
      live();
      const requested = checkKey(opts?.streamId);
      if (params !== undefined && !Array.isArray(params)) {
        throw new DbRpcError("INVALID", "params must be an array");
      }
      return once("query", requested, async () => {
        if (!options.sweepInterval) sweep();
        if (streams.size + starting >= maxStreams) {
          throw new DbRpcError("TOO_MANY_STREAMS", `${maxStreams} results are open`);
        }
        starting++;
        let pages: DbEntry[][];
        try {
          pages = toPages(
            await run((target) => target.query(sql, params ?? [])),
            pageRows,
            pageBytes,
          );
        } finally {
          starting--;
        }
        live();
        const streamId = requested ?? newKey();
        if (pages.length > 1) streams.set(streamId, { pages, touched: now() });
        return { streamId, pages: pages.length, rows: pages[0] ?? [] };
      });
    },

    async readPage(streamId: string, pageId: number): Promise<QueryPage> {
      live();
      const stream = streams.get(String(streamId));
      if (!stream) throw new DbRpcError("UNKNOWN_STREAM", `no open result '${String(streamId)}'`);
      stream.touched = now();
      if (!Number.isInteger(pageId) || pageId < 0 || pageId >= stream.pages.length) {
        throw new DbRpcError(
          "INVALID",
          `page ${String(pageId)} is outside 0..${stream.pages.length - 1}`,
        );
      }
      return {
        rows: stream.pages[pageId] ?? [],
        done: pageId === stream.pages.length - 1,
      };
    },

    async closeQuery(streamId: string): Promise<void> {
      streams.delete(String(streamId));
    },

    async exec(sql: string, opts?: RequestOptions): Promise<void> {
      live();
      return once("exec", checkKey(opts?.requestId), () => run((target) => target.exec(sql)));
    },

    async flush(opts?: RequestOptions): Promise<void> {
      live();
      return once("flush", checkKey(opts?.requestId), async () => {
        await db.flush?.();
      });
    },

    sweep,
    openStreams: () => streams.size,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      streams.clear();
      answers.clear();
    },
  };
  return server;
}
