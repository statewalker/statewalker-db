# @statewalker/db-duckdb-browser

DuckDB WASM driver for [`@statewalker/db-api`](../db-api), for the browser. It
starts DuckDB (`@duckdb/duckdb-wasm`) in a Web Worker and returns a `Db`. The
database is in memory by default; with an OPFS path and self-hosted bundles it
persists across page reloads.

## Install

```sh
pnpm add @statewalker/db-duckdb-browser
```

`@duckdb/duckdb-wasm` and `@statewalker/db-api` are regular dependencies; no
peer dependencies.

## Entry points

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-duckdb-browser` | `newBrowserDuckDb`, type `BrowserDuckDbOptions`; re-exports types `Db`, `DbEntry`, `DbOptions` | browser (needs `Worker`) |

The package also ships its TypeScript sources in `src/`.

## Usage

In memory, with the DuckDB bundle loaded from jsDelivr:

```ts
import { newBrowserDuckDb } from "@statewalker/db-duckdb-browser";

const db = await newBrowserDuckDb();
await db.exec("CREATE TABLE t (x INTEGER)");
await db.exec("INSERT INTO t VALUES (1), (2)");
const rows = await db.query<{ x: number }>("SELECT x FROM t WHERE x > $1", [1]);
await db.close();
```

Persistent on OPFS. This needs same-origin bundle URLs (a cross-origin worker
fails on OPFS file I/O). With Vite, for example (add `@duckdb/duckdb-wasm`
to your own dependencies to import its files):

```ts
import { newBrowserDuckDb } from "@statewalker/db-duckdb-browser";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

const db = await newBrowserDuckDb({
  path: "opfs://app.duckdb",
  bundles: {
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  },
});
// ... writes ...
await db.flush?.(); // runs CHECKPOINT so the writes reach the OPFS file
```

## API

- `newBrowserDuckDb(options?: BrowserDuckDbOptions): Promise<Db>`
  - `options.path`: OPFS path (for example `opfs://app.duckdb`). If opening it
    fails, the driver silently falls back to an in-memory database.
  - `options.bundles`: `DuckDBBundles` with same-origin URLs. Required for OPFS.
    Without it the bundle comes from jsDelivr (in-memory use only).
- The returned `Db` implements `query`, `exec`, `flush` and `close`. `flush`
  runs `CHECKPOINT` when the database is persistent and does nothing otherwise.
  `close` closes the connection, terminates DuckDB and the worker.
- Parameters use DuckDB placeholders (`$1`, `$2`, ...). Rows are plain objects
  converted from Arrow results.

## Related

- [`@statewalker/db-api`](../db-api): the `Db` interface.
- [`@statewalker/db-duckdb-node`](../db-duckdb-node): the Node.js counterpart.
