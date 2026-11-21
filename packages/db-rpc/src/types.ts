import type { DbEntry } from "@statewalker/db-api";

/** Options of `query`. */
export interface QueryOptions {
  /**
   * The result's id, chosen by the caller (16 to 128 characters of `[A-Za-z0-9_-]`, random:
   * `crypto.randomUUID()` without dashes), so that a `query` delivered twice runs once and both
   * deliveries get the same answer. Without it the server chooses one and a repeated delivery
   * runs again.
   */
  streamId?: string;
}

/** Options of `exec` and `flush`. */
export interface RequestOptions {
  /**
   * The call's id, chosen by the caller (the same form as a stream id). The server keeps each
   * id's answer for `idleTimeout` (at most `maxRequests` of them): the same call delivered again
   * gets that answer and does not run again.
   */
  requestId?: string;
}

/** The answer to `query`: the result's first page and how many pages it has. */
export interface QueryResult {
  /** The result's id: ask for pages `1 .. pages - 1` with `readPage(streamId, k)`. */
  streamId: string;
  /** How many pages the result has (at least 1; a result with no rows has one empty page). */
  pages: number;
  /** The rows of page 0. */
  rows: DbEntry[];
}

/** One page of a result. */
export interface QueryPage {
  rows: DbEntry[];
  /** Whether this is the last page. */
  done: boolean;
}

/**
 * What the server exposes and the client calls: a `Db` cut into calls an RPC can carry. Every
 * argument and result is a structured-clonable value (strings, numbers, bigints, booleans, null,
 * plain objects, arrays, `Uint8Array`, `Date`), so Durable Object and Workers RPC, postMessage,
 * comlink or a direct call carry it.
 *
 * A result is cut into pages keyed by `(streamId, pageId)`: `query` answers page 0 and the page
 * count, `readPage` answers any page of a result still open, as often as it is asked, and
 * `closeQuery` drops it. A result of one page is never kept open.
 */
export interface DbRpc {
  /** Runs one statement (as `Db.query`) and answers its first page. */
  query(sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult>;
  /** Page `pageId` (0 to `pages - 1`) of a result that is still open. */
  readPage(streamId: string, pageId: number): Promise<QueryPage>;
  /** Drops a result (unknown or closed: nothing happens). */
  closeQuery(streamId: string): Promise<void>;
  /** Runs statements that return no rows (as `Db.exec`). */
  exec(sql: string, options?: RequestOptions): Promise<void>;
  /** The served Db's `flush`, when it has one; otherwise nothing happens. */
  flush(options?: RequestOptions): Promise<void>;
}

/** Error codes of DbRpcError. */
export type DbRpcErrorCode = "UNKNOWN_STREAM" | "TOO_MANY_STREAMS" | "ABORTED" | "INVALID";
