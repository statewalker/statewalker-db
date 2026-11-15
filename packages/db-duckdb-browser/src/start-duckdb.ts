import * as duckdb from "@duckdb/duckdb-wasm";

/**
 * What {@link startDuckDb} needs from the page. The browser defaults are
 * {@link browserStartEnv}; tests pass fakes to drive failures.
 */
export interface DuckDbStartEnv {
  newWorker(url: string): Worker;
  newDb(worker: Worker): duckdb.AsyncDuckDB;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

/** A started engine: its worker, the engine and one open connection. */
export interface StartedDuckDb {
  worker: Worker;
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}

/** The real browser environment: a Web Worker and the page's `URL`. */
export const browserStartEnv: DuckDbStartEnv = {
  newWorker: (url) => new Worker(url),
  newDb: (worker) => new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

/**
 * Start a worker, instantiate DuckDB in it, open `path` if given, and connect.
 *
 * If any step fails, the engine and its worker are terminated before the
 * error is rethrown, so a failed start leaves no worker running. The Blob URL
 * of the jsDelivr shim is revoked whether the start succeeds or fails.
 */
export async function startDuckDb(
  bundle: duckdb.DuckDBBundle,
  options: { selfHosted: boolean; path?: string },
  env: DuckDbStartEnv,
): Promise<StartedDuckDb> {
  const { selfHosted, path } = options;
  let blobUrl: string | undefined;
  let worker: Worker | undefined;
  let db: duckdb.AsyncDuckDB | undefined;
  try {
    // OPFS file I/O needs a same-origin worker. Self-hosted bundles give a
    // same-origin URL we load directly; the jsDelivr fallback is cross-origin
    // and must be wrapped in a Blob that `importScripts` it.
    if (selfHosted) {
      worker = env.newWorker(bundle.mainWorker as string);
    } else {
      blobUrl = env.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker ?? ""}");`], {
          type: "text/javascript",
        }),
      );
      worker = env.newWorker(blobUrl);
    }
    db = env.newDb(worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    if (path) {
      try {
        await db.open({ path, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
      } catch (error) {
        throw new Error(`Cannot open DuckDB database "${path}"`, { cause: error });
      }
    }
    const conn = await db.connect();
    return { worker, db, conn };
  } catch (error) {
    // Best effort: a failing teardown must not hide the start error.
    try {
      await db?.terminate();
    } catch {}
    worker?.terminate();
    throw error;
  } finally {
    if (blobUrl) env.revokeObjectURL(blobUrl);
  }
}
