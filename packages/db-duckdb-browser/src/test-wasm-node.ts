import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as duckdb from "@duckdb/duckdb-wasm/blocking";

/**
 * Test helper: the same duckdb-wasm build the driver uses, through its
 * synchronous Node bindings (no Worker, no network), so Node unit tests get
 * real Arrow results from DuckDB WASM. Not exported from the package.
 */
export async function openWasmNodeConnection(): Promise<duckdb.DuckDBConnection> {
  const require = createRequire(import.meta.url);
  const dist = dirname(require.resolve("@duckdb/duckdb-wasm/blocking"));
  const bundles: duckdb.DuckDBBundles = {
    mvp: {
      mainModule: join(dist, "duckdb-mvp.wasm"),
      mainWorker: join(dist, "duckdb-node-mvp.worker.cjs"),
    },
    eh: {
      mainModule: join(dist, "duckdb-eh.wasm"),
      mainWorker: join(dist, "duckdb-node-eh.worker.cjs"),
    },
  };
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  return db.connect();
}
