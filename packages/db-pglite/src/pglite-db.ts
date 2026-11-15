import { type Extensions, PGlite } from "@electric-sql/pglite";
import type { Db } from "@statewalker/db-api";
import { newSerialisedDb } from "@statewalker/db-sqlite";

export type PgliteDbOptions = {
  /** PGlite data directory: a folder on Node.js, `idb://<name>` in a browser. Omit for in-memory. */
  path?: string;
  /** PGlite extensions to load, e.g. `{ vector }` from `@electric-sql/pglite-pgvector`. */
  extensions?: Record<string, unknown>;
};

/**
 * Create a {@link Db} on PGlite. Use `$1`, `$2`, ... placeholders. Calls run one at a time, in
 * call order; `close()` waits for them, then closes PGlite; later calls reject with
 * `db-pglite: the database is closed`.
 */
export async function newPgliteDb(options?: PgliteDbOptions): Promise<Db> {
  const pg = await PGlite.create({
    dataDir: options?.path,
    extensions: options?.extensions as Extensions | undefined,
  });
  return newSerialisedDb(
    {
      query: async (sql, params) => (await pg.query<Record<string, unknown>>(sql, params)).rows,
      exec: async (sql) => {
        await pg.exec(sql);
      },
      close: () => pg.close(),
    },
    { name: "db-pglite" },
  );
}
