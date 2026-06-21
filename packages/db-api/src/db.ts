/** A plain record returned by queries when no specific type is provided. */
export type DbEntry = Record<string, unknown>;

/** Minimal database interface — implementation-agnostic. */
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
  /** Release all resources held by this database. */
  close(): Promise<void>;
};

/** Options accepted by every `newXxxDuckDb` factory. */
export type DbOptions = {
  /** File path (node) or OPFS path (browser). Omit for in-memory. */
  path?: string;
};
