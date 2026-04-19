import * as duckdb from "@duckdb/duckdb-wasm";
import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";
import type { Table } from "apache-arrow";

/**
 * Convert an Arrow Table (returned by duckdb-wasm queries) to plain JS objects.
 */
function arrowToObjects<T>(table: Table): T[] {
  const fields = table.schema.fields.map((f: { name: string }) => f.name);
  return table.toArray().map((row: Record<string, unknown>) => {
    const obj: Record<string, unknown> = {};
    for (const field of fields) {
      obj[field] = row[field];
    }
    return obj as T;
  });
}

/**
 * Create a DuckDB-backed {@link Db} using WebAssembly in the browser.
 *
 * When OPFS is available the database persists across sessions.
 * Falls back to in-memory when OPFS is not supported.
 *
 * @param options.path  OPFS path for persistent storage. Omit for in-memory.
 */
export async function newBrowserDuckDb(options?: DbOptions): Promise<Db> {
  const BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(BUNDLES);

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker ?? ""}");`], {
      type: "text/javascript",
    }),
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  // Enable OPFS persistence when a path is provided and the API is available
  if (options?.path && typeof navigator !== "undefined" && navigator.storage) {
    try {
      await db.open({
        path: options.path,
        accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      });
    } catch {
      // Fall back to in-memory if OPFS is unavailable
    }
  }

  const conn = await db.connect();

  return {
    async query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]> {
      if (params && params.length > 0) {
        const stmt = await conn.prepare(sql);
        const result = await stmt.query(...params);
        return arrowToObjects<T>(result);
      }
      const result = await conn.query(sql);
      return arrowToObjects<T>(result);
    },

    async exec(sql: string): Promise<void> {
      await conn.query(sql);
    },

    async close(): Promise<void> {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
