import type { Database, Sqlite3Static } from "@libsql/libsql-wasm-experimental";
import sqlite3InitModule from "@libsql/libsql-wasm-experimental";
import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";

export type BrowserDbOptions = DbOptions & {
  /** URL to the sqlite3.wasm file. Defaults to "/sqlite3.wasm". */
  wasmUrl?: string;
};

let sqlite3Promise: Promise<Sqlite3Static> | undefined;

function getSqlite3(wasmUrl: string): Promise<Sqlite3Static> {
  if (!sqlite3Promise) {
    sqlite3Promise = sqlite3InitModule({
      locateFile: (file: string) => (file.endsWith(".wasm") ? wasmUrl : file),
    });
  }
  return sqlite3Promise;
}

/**
 * Create a libSQL WASM-backed {@link Db} in the browser.
 *
 * Uses `@libsql/libsql-wasm-experimental` which provides the full libSQL
 * engine (FTS5, vector search) compiled to WebAssembly.
 *
 * @param options.path  File path for persistent storage. Omit for in-memory.
 * @param options.wasmUrl  URL to the sqlite3.wasm file. Defaults to "/sqlite3.wasm".
 */
export async function newBrowserSqliteDb(options?: BrowserDbOptions): Promise<Db> {
  const wasmUrl = options?.wasmUrl ?? "/sqlite3.wasm";
  const sqlite3 = await getSqlite3(wasmUrl);
  const dbPath = options?.path ?? ":memory:";
  const db: Database = new sqlite3.oo1.DB(dbPath, "c");

  return {
    async query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]> {
      const rows = db.exec(sql, {
        returnValue: "resultRows",
        rowMode: "object",
        bind: params as never[],
      });
      return rows as unknown as T[];
    },

    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
