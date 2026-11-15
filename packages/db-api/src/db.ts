/** A plain record returned by queries when no specific type is provided. */
export type DbEntry = Record<string, unknown>;

/**
 * Minimal database interface — implementation-agnostic. Every `@statewalker/db-*` driver keeps
 * these guarantees, and the shared conformance suite (`runDbConformance`) checks them on each one.
 *
 * **Lifecycle**
 * - Calls (`query`, `exec`, `flush`, and a SQLite `inTransaction`) run one at a time, in call
 *   order: each starts once the calls made before it have settled, whether or not the caller
 *   awaited them. A failed call does not stop the ones after it.
 * - `close()` waits for the calls made before it, then closes.
 * - A call made once `close()` has started rejects with an `Error` whose message is
 *   `<driver>: the database is closed` (`db-sqlite`, `db-duckdb-node`, `db-duckdb-browser`,
 *   `db-pglite`).
 * - Closing twice is a no-op: a second `close()`, overlapping or later, resolves once the first
 *   has finished.
 *
 * **Values in rows**
 * - BLOB (BYTEA on PGlite): a `Uint8Array` (DuckDB on Node.js returns a `Buffer`, a `Uint8Array`
 *   subclass). Every driver binds a `Uint8Array` parameter as a BLOB, except DuckDB WASM, whose
 *   parameters are JSON-encoded: it rejects one with a `TypeError`.
 * - Integers: a `number` within ±(2^53 - 1), a `bigint` beyond, whatever the column type
 *   (INTEGER, BIGINT, HUGEINT, `count(*)`), also inside lists and structs. A `bigint`
 *   parameter binds as an integer.
 * - Decimals: the engine's type, as there is no lossless common one. DuckDB returns a `number`
 *   (the nearest double); PGlite returns NUMERIC as its exact decimal string (`"1.25"`); SQLite
 *   has no decimal type and returns a `number`.
 * - Dates: every driver binds a `Date` parameter. DuckDB and PGlite return DATE, TIMESTAMP and
 *   TIMESTAMPTZ as a `Date`; SQLite has no date type: it binds a `Date` as ISO 8601 UTC text
 *   (`date.toISOString()`) and returns that text.
 */
export type Db = {
  /** Execute a SQL query and return rows as typed objects. */
  query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Execute a SQL statement that returns no rows (DDL / DML). */
  exec(sql: string): Promise<void>;
  /**
   * Flush committed writes to durable storage. For backends that buffer (e.g.
   * DuckDB-WASM over OPFS, which only writes its file on CHECKPOINT) this makes
   * prior writes survive an abrupt teardown such as a page reload. Optional:
   * in-memory or auto-syncing backends omit it.
   */
  flush?(): Promise<void>;
  /**
   * Release all resources held by this database, once the calls made before it have settled.
   * Later calls reject with `<driver>: the database is closed`; closing again is a no-op.
   */
  close(): Promise<void>;
};

/** Options accepted by every driver factory (`newNodeSqliteDb`, `newNodeDuckDb`, …). */
export type DbOptions = {
  /** File path (node) or OPFS path (browser). Omit for in-memory. */
  path?: string;
};
