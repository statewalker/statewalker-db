import { type Extensions, PGlite } from "@electric-sql/pglite";
import type { Db, DbEntry } from "@statewalker/db-api";

export type PgliteDbOptions = {
  /** PGlite data directory: a folder on Node.js, `idb://<name>` in a browser. Omit for in-memory. */
  path?: string;
  /** PGlite extensions to load, e.g. `{ vector }` from `@electric-sql/pglite-pgvector`. */
  extensions?: Record<string, unknown>;
};

/** Create a {@link Db} on PGlite. Use `$1`, `$2`, ... placeholders. */
export async function newPgliteDb(options?: PgliteDbOptions): Promise<Db> {
  const pg = await PGlite.create({
    dataDir: options?.path,
    extensions: options?.extensions as Extensions | undefined,
  });
  let closed = false;
  const live = () => {
    if (closed) throw new Error("db-pglite: the database is closed");
  };
  return {
    async query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]> {
      live();
      return (await pg.query<T>(sql, params ?? [])).rows;
    },
    async exec(sql: string): Promise<void> {
      live();
      await pg.exec(sql);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pg.close();
    },
  };
}
