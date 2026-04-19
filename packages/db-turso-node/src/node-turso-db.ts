import type { InValue } from "@libsql/client";
import { createClient } from "@libsql/client";
import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";

/**
 * Create a libSQL-backed {@link Db} using Turso's native Node.js client.
 *
 * @param options.path  File path for persistent storage. Omit for in-memory.
 */
export async function newNodeTursoDb(options?: DbOptions): Promise<Db> {
  const url = options?.path ? `file:${options.path}` : ":memory:";
  const client = createClient({ url });

  return {
    async query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await client.execute(
        params && params.length > 0 ? { sql, args: params as InValue[] } : sql,
      );
      return result.rows as unknown as T[];
    },

    async exec(sql: string): Promise<void> {
      await client.execute(sql);
    },

    async close(): Promise<void> {
      client.close();
    },
  };
}
