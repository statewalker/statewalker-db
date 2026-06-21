import * as duckdb from "@duckdb/duckdb-wasm";
import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";

type Table = Awaited<ReturnType<duckdb.AsyncPreparedStatement["query"]>>;

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
 * `options.bundles`, the database persists across reloads on OPFS. Otherwise it
 * runs in-memory.
 *
 * @param options.path     `opfs://` path for persistent storage. Omit for in-memory.
 * @param options.bundles  Same-origin bundle URLs (required for OPFS).
 */
export async function newBrowserDuckDb(options?: BrowserDuckDbOptions): Promise<Db> {
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

  // Enable OPFS persistence when a path is provided and the API is available.
  const persistent =
    Boolean(options?.path) && typeof navigator !== "undefined" && Boolean(navigator.storage);
  if (options?.path && persistent) {
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

    async flush(): Promise<void> {
      // CHECKPOINT writes the WAL into the OPFS database file so committed
      // changes survive a reload. Crucial for OPFS persistence.
      if (persistent) await conn.query("CHECKPOINT");
    },

    async close(): Promise<void> {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
