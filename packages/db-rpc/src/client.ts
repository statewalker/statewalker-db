import type { Db, DbEntry } from "@statewalker/db-api";
import { DbRpcError } from "./errors.js";
import type { DbRpc } from "./types.js";

export interface DbRpcClientOptions {
  /** The server's methods, through any transport (a stub, a proxy, the server itself). */
  rpc: DbRpc;
  /** `readPage` calls kept in flight while reading a result of several pages. Default 4. */
  readAhead?: number;
}

const newKey = () => crypto.randomUUID().replace(/-/g, "");

const CLOSED = "db-rpc: the database is closed";

/**
 * A {@link Db} whose every call goes through a {@link DbRpc}. Calls run one at a time, in call
 * order, whatever order the transport delivers in; `close()` waits for them, then refuses later
 * calls (`db-rpc: the database is closed`). It closes only this client: the served Db stays open.
 */
export function newDbRpcClient(options: DbRpcClientOptions): Db & { flush(): Promise<void> } {
  const { rpc } = options;
  const readAhead = Math.max(1, options.readAhead ?? 4);

  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => undefined);
    return result;
  };
  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    closing ? Promise.reject(new Error(CLOSED)) : enqueue(fn);

  const query = async (sql: string, params: unknown[]): Promise<DbEntry[]> => {
    const first = await rpc.query(sql, params, { streamId: newKey() });
    const pages = first?.pages;
    if (!Number.isInteger(pages) || pages < 1 || !Array.isArray(first.rows)) {
      throw new DbRpcError("INVALID", "the server answered query with no page count or rows");
    }
    if (pages === 1) return first.rows;
    const { streamId } = first;
    try {
      const rest: DbEntry[][] = new Array(pages - 1);
      let next = 1;
      const worker = async () => {
        while (next < pages) {
          const k = next++;
          const page = await rpc.readPage(streamId, k);
          if (!Array.isArray(page?.rows)) {
            throw new DbRpcError("INVALID", `the server answered page ${k} with no rows`);
          }
          rest[k - 1] = page.rows;
        }
      };
      await Promise.all(Array.from({ length: Math.min(readAhead, pages - 1) }, worker));
      return first.rows.concat(...rest);
    } finally {
      await rpc.closeQuery(streamId).catch(() => undefined);
    }
  };

  return {
    query: <T = DbEntry>(sql: string, params: unknown[] = []) =>
      run(() => query(sql, params) as Promise<T[]>),
    exec: (sql: string) => run(() => rpc.exec(sql, { requestId: newKey() })),
    flush: () => run(() => rpc.flush({ requestId: newKey() })),
    close: () => {
      closing ??= enqueue(async () => {});
      return closing;
    },
  };
}
