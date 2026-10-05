# @statewalker/db-duckdb-browser

## What it is

A DuckDB driver for the browser that implements `Db` from
`@statewalker/db-api`. It runs DuckDB WASM (`@duckdb/duckdb-wasm`) in a Web
Worker. The database lives in memory, or in an OPFS file that survives page
reloads.

## Why it exists

DuckDB WASM has its own asynchronous API built around Arrow tables, worker
setup and bundle selection. This package hides that behind the four `Db`
methods and returns rows as plain objects, so the same code runs on this
driver and on `@statewalker/db-duckdb-node`.

## How to use

```sh
pnpm add @statewalker/db-duckdb-browser
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-duckdb-browser` | `newBrowserDuckDb`, type `BrowserDuckDbOptions`; types `Db`, `DbEntry`, `DbOptions` re-exported from `@statewalker/db-api` | browser (needs `Worker`) |

`newBrowserDuckDb(options?)` returns `Promise<Db>`.

- `options.path`: an OPFS path such as `opfs://app.duckdb`. Omit it for an
  in-memory database.
- `options.bundles`: same-origin `DuckDBBundles` URLs. Required for OPFS.
  Without it, the bundle is loaded from jsDelivr.

The returned `Db` implements `query`, `exec`, `flush` and `close`. Placeholders
are DuckDB's (`$1`, `$2`, ...).

## Examples

In memory, bundle from jsDelivr:

```ts
import { newBrowserDuckDb } from "@statewalker/db-duckdb-browser";

const db = await newBrowserDuckDb();
await db.exec("CREATE TABLE t (x INTEGER)");
await db.exec("INSERT INTO t VALUES (1), (2)");
const rows = await db.query<{ x: number }>("SELECT x FROM t WHERE x > $1", [1]);
await db.close();
```

Persistent on OPFS, with bundles served by Vite from your own origin (add
`@duckdb/duckdb-wasm` to your dependencies to import its files):

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
await db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER, body VARCHAR)");
await db.exec("INSERT INTO notes VALUES (1, 'hello')");
await db.flush?.(); // CHECKPOINT: without it the insert can be lost on reload
```

## Internals

```
 page                              Web Worker
 newBrowserDuckDb() --- AsyncDuckDB ---> DuckDB WASM ---> OPFS file (optional)
 query() <-- Arrow table --> plain objects
```

- **Same-origin worker for OPFS.** OPFS file I/O works only in a same-origin
  worker. With `bundles`, the worker is created directly from your URL. Without
  them, the jsDelivr worker is cross-origin and is started through a Blob that
  calls `importScripts`; that worker crashes on OPFS file I/O, so use it for
  in-memory databases only.
- **`flush` runs `CHECKPOINT`.** DuckDB WASM writes the OPFS database file only
  on `CHECKPOINT`. Writes not yet checkpointed can be lost on an abrupt
  teardown such as a page reload. On an in-memory database `flush` does
  nothing.
- **Silent fallback to memory.** If `options.path` is set but opening it
  throws, or `navigator.storage` is missing, the driver continues with an
  in-memory database and raises no error. The symptom is data that is gone
  after a reload.
- **Rows.** Query results are Arrow tables; the driver copies each row's
  fields into a plain object. Calls with parameters go through
  `conn.prepare(sql)` and `stmt.query(...params)`; calls without parameters use
  `conn.query(sql)`.
- **Under Node.js** the module imports, but `newBrowserDuckDb()` rejects with
  `Worker is not defined`. Use `@statewalker/db-duckdb-node` there.
- **Dependencies:** `@duckdb/duckdb-wasm` (the engine), `@statewalker/db-api`
  (the interface types).

## License

MIT
