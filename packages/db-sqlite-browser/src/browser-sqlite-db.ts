import sqlite3InitModule, {
  type BindableValue,
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import type { Db, DbOptions } from "@statewalker/db-api";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";

export type BrowserDbOptions = DbOptions & {
  /** URL of `sqlite3.wasm`. Default: the package's own file, located by the bundler. */
  wasmUrl?: string;
};

const MAIN_THREAD_PATH =
  'newBrowserSqliteDb: { path } needs a Dedicated Worker (the "opfs-sahpool" OPFS VFS runs only ' +
  "there). On the main thread, omit path for an in-memory database.";

type InitModule = (module?: { locateFile?: (file: string) => string }) => Promise<Sqlite3Static>;

/** One engine per wasmUrl, started on first use; one OPFS pool per engine. */
const engines = new Map<string, Promise<Sqlite3Static>>();
const pools = new WeakMap<Sqlite3Static, Promise<SAHPoolUtil>>();

function getSqlite3(wasmUrl: string | undefined): Promise<Sqlite3Static> {
  const key = wasmUrl ?? "";
  let engine = engines.get(key);
  if (!engine) {
    engine = (sqlite3InitModule as InitModule)(
      wasmUrl ? { locateFile: (file) => (file.endsWith(".wasm") ? wasmUrl : file) } : undefined,
    );
    engines.set(key, engine);
  }
  return engine;
}

function getPool(sqlite3: Sqlite3Static): Promise<SAHPoolUtil> {
  let pool = pools.get(sqlite3);
  if (!pool) {
    pool = sqlite3.installOpfsSAHPoolVfs({});
    pools.set(sqlite3, pool);
  }
  return pool;
}

const inDedicatedWorker = () =>
  typeof (globalThis as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope !==
  "undefined";

/**
 * Create a SQLite {@link Db} on `@sqlite.org/sqlite-wasm`.
 *
 * @param options.path     OPFS database name; Dedicated Worker only. Omit for in-memory.
 * @param options.wasmUrl  URL of `sqlite3.wasm`, when the bundler cannot locate it.
 */
export async function newBrowserSqliteDb(options?: BrowserDbOptions): Promise<Db> {
  if (options?.path && !inDedicatedWorker()) throw new Error(MAIN_THREAD_PATH);
  const sqlite3 = await getSqlite3(options?.wasmUrl);
  const db: Database = options?.path
    ? new (await getPool(sqlite3)).OpfsSAHPoolDb(options.path)
    : new sqlite3.oo1.DB(":memory:", "c");
  return newSerialisedSqliteDb({
    all: (sql, params) =>
      db.exec({
        sql,
        bind: params.length > 0 ? (params as BindableValue[]) : undefined,
        rowMode: "object",
        returnValue: "resultRows",
      }) as Record<string, unknown>[],
    exec: (sql) => {
      db.exec(sql);
    },
    close: () => db.close(),
  });
}
