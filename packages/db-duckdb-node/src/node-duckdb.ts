import type { DuckDBValue } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";

/**
 * Create a DuckDB-backed {@link Db} using native Node.js bindings.
 *
 * @param options.path  File path for persistent storage. Omit for in-memory.
 */
export async function newNodeDuckDb(options?: DbOptions): Promise<Db> {
  const instance = await DuckDBInstance.create(options?.path ?? ":memory:");
  const connection = await instance.connect();

  return {
    async query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]> {
      if (params && params.length > 0) {
        const prepared = await connection.prepare(sql);
        prepared.bind(params as DuckDBValue[]);
        const reader = await prepared.runAndReadAll();
        return reader.getRowObjectsJS() as T[];
      }
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJS() as T[];
    },

    async exec(sql: string): Promise<void> {
      await connection.run(sql);
    },

    async close(): Promise<void> {
      connection.closeSync();
      instance.closeSync();
    },
  };
}
