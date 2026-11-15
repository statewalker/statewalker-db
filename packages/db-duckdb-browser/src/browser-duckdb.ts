import * as duckdb from "@duckdb/duckdb-wasm";
import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";
import { arrowTableToObjects } from "./arrow-values.js";
import { toDuckDbParams } from "./params.js";
import { browserStartEnv, startDuckDb } from "./start-duckdb.js";

/** Browser-specific options for {@link newBrowserDuckDb}. */
export interface BrowserDuckDbOptions extends DbOptions {
  /**
   * Self-hosted DuckDB bundle URLs (served same-origin, e.g. via a bundler's
   * `?url` import). Passing these makes the factory spawn a **same-origin**
   * worker, which OPFS database persistence requires — a cross-origin worker
   * (the jsDelivr fallback, loaded via a Blob `importScripts` shim) crashes on
   * OPFS file I/O. Omit to load from jsDelivr (in-memory use only); a `path`
   * without `bundles` is rejected.
   */
  bundles?: duckdb.DuckDBBundles;
}

/**
 * Create a DuckDB-backed {@link Db} using WebAssembly in the browser.
 *
 * With `options.path` set to an `opfs://` URL **and** self-hosted
 * `options.bundles`, the database persists across reloads on OPFS. Without
 * `options.path` it runs in-memory. If `options.path` cannot be opened, the
 * returned promise rejects; it never falls back to an in-memory database.
 * `options.path` without `options.bundles` rejects before any worker starts.
 *
 * @param options.path     `opfs://` path for persistent storage. Omit for in-memory.
 * @param options.bundles  Same-origin bundle URLs (required for OPFS).
 */
export async function newBrowserDuckDb(options?: BrowserDuckDbOptions): Promise<Db> {
  const path = options?.path;
  const selfHosted = options?.bundles;
  if (path && !selfHosted) {
    // The jsDelivr worker is cross-origin and crashes on OPFS file I/O.
    throw new Error(
      `Cannot open DuckDB database "${path}": OPFS needs self-hosted \`bundles\` (a same-origin worker)`,
    );
  }
  if (path && (typeof navigator === "undefined" || !navigator.storage)) {
    throw new Error(`Cannot open DuckDB database "${path}": OPFS is unavailable`);
  }
  const bundle = await duckdb.selectBundle(selfHosted ?? duckdb.getJsDelivrBundles());
  const { worker, db, conn } = await startDuckDb(
    bundle,
    { selfHosted: selfHosted !== undefined, path },
    browserStartEnv,
  );

  return {
    async query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]> {
      if (params && params.length > 0) {
        // Convert first: an unsupported param throws before a statement exists.
        const bound = toDuckDbParams(params);
        const stmt = await conn.prepare(sql);
        try {
          const result = await stmt.query(...bound);
          return arrowTableToObjects<T>(result);
        } finally {
          await stmt.close();
        }
      }
      const result = await conn.query(sql);
      return arrowTableToObjects<T>(result);
    },

    async exec(sql: string): Promise<void> {
      await conn.query(sql);
    },

    async flush(): Promise<void> {
      // CHECKPOINT writes the WAL into the OPFS database file so committed
      // changes survive a reload. Crucial for OPFS persistence.
      if (path) await conn.query("CHECKPOINT");
    },

    async close(): Promise<void> {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
