import * as duckdb from "@duckdb/duckdb-wasm";
import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";
import { arrowTableToObjects } from "./arrow-values.js";
import { toDuckDbParams } from "./params.js";

/** Browser-specific options for {@link newBrowserDuckDb}. */
export interface BrowserDuckDbOptions extends DbOptions {
  /**
   * Self-hosted DuckDB bundle URLs (served same-origin, e.g. via a bundler's
   * `?url` import). Passing these makes the factory spawn a **same-origin**
   * worker, which OPFS database persistence requires — a cross-origin worker
   * (the jsDelivr fallback, loaded via a Blob `importScripts` shim) crashes on
   * OPFS file I/O. Omit to load from jsDelivr (in-memory use only).
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
 *
 * @param options.path     `opfs://` path for persistent storage. Omit for in-memory.
 * @param options.bundles  Same-origin bundle URLs (required for OPFS).
 */
export async function newBrowserDuckDb(options?: BrowserDuckDbOptions): Promise<Db> {
  const path = options?.path;
  if (path && (typeof navigator === "undefined" || !navigator.storage)) {
    throw new Error(`Cannot open DuckDB database "${path}": OPFS is unavailable`);
  }
  const selfHosted = options?.bundles;
  const bundle = await duckdb.selectBundle(selfHosted ?? duckdb.getJsDelivrBundles());

  // OPFS file I/O needs a same-origin worker. Self-hosted bundles give a
  // same-origin URL we load directly; the jsDelivr fallback is cross-origin and
  // must be wrapped in a Blob that `importScripts` it.
  let worker: Worker;
  let blobUrl: string | undefined;
  if (selfHosted) {
    worker = new Worker(bundle.mainWorker as string);
  } else {
    blobUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker ?? ""}");`], {
        type: "text/javascript",
      }),
    );
    worker = new Worker(blobUrl);
  }

  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  if (blobUrl) URL.revokeObjectURL(blobUrl);

  if (path) {
    try {
      await db.open({
        path,
        accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      });
    } catch (error) {
      await db.terminate();
      worker.terminate();
      throw new Error(`Cannot open DuckDB database "${path}"`, { cause: error });
    }
  }

  const conn = await db.connect();

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
