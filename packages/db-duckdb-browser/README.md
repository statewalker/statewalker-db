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
  in-memory database. If the path cannot be opened, the call rejects with
  `Cannot open DuckDB database "<path>"`; it never falls back to memory.
- `options.bundles`: same-origin `DuckDBBundles` URLs. Required for OPFS.
  Without it, the bundle is loaded from jsDelivr.

The returned `Db` implements `query`, `exec`, `flush` and `close`. Placeholders
are DuckDB's (`$1`, `$2`, ...).

### Result values

Rows come back with the same JS values as `@statewalker/db-duckdb-node`:

| DuckDB type | JS value |
| --- | --- |
| `DECIMAL` | `number` (scaled; `1.25::DECIMAL(10,2)` is `1.25`) |
| `BIGINT`, `UBIGINT`, `HUGEINT`, `TIME` | `bigint` |
| `INTEGER`, `DOUBLE`, ... | `number` |
| `DATE`, `TIMESTAMP`, `TIMESTAMPTZ` | `Date` |
| `LIST`, fixed-size `ARRAY` | array, converted recursively |
| `STRUCT` | plain object, converted recursively |
| `MAP` | array of `{ key, value }` |
| `BLOB` | `Uint8Array` |

`INTERVAL` is returned as duckdb-wasm's Arrow layer decodes it and does not
match the node driver; cast it in SQL (for example to `VARCHAR`) if you need
it. A `HUGEINT` and a `DECIMAL(38,0)` look the same in Arrow, so both come
back as `bigint`.

### Parameter limits

duckdb-wasm passes parameters through `JSON.stringify`, so the driver converts
them first:

| JS value | Bound as |
| --- | --- |
| `string`, `boolean`, `null` | itself (`undefined` binds as `null`) |
| finite `number` | `DOUBLE` |
| `bigint` | its exact decimal string, cast by DuckDB to the column's type |
| `Date` | its ISO 8601 string (`toISOString()`), cast to `TIMESTAMP` the same way |

The string forms work where the SQL fixes the parameter's type, as in
`WHERE id = $1` or `INSERT INTO t (id) VALUES ($1)`, so a `BIGINT` id read
from one query can be passed back to the next. Where nothing fixes it, cast
in SQL: `$1::BIGINT + 1`, `$1::TIMESTAMP`.

`Uint8Array` and other binary data, arrays, objects, `NaN`, `Infinity` and
invalid dates are rejected with a `TypeError` that names the parameter and its
type (`cannot bind parameter $1 of type Uint8Array`). Insert such values with
SQL literals, or through duckdb-wasm's own Arrow insert API.

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
- **No fallback to memory.** If `options.path` is set but `navigator.storage`
  is missing, the call rejects with
  `Cannot open DuckDB database "<path>": OPFS is unavailable`. If opening the
  path throws, the worker is terminated and the call rejects with
  `Cannot open DuckDB database "<path>"`, the engine's error as `cause`. An
  in-memory database is created only when `options.path` is omitted, so data
  is never silently lost on reload.
- **Rows.** Query results are Arrow tables; the driver copies each row into a
  plain object, converting each value by its Arrow field type
  (`src/arrow-values.ts`). Calls with parameters convert them
  (`src/params.ts`), then go through `conn.prepare(sql)` and
  `stmt.query(...params)`, and the statement is closed after each call, also
  when the query fails; calls without parameters use `conn.query(sql)`.
- **Under Node.js** the module imports, but `newBrowserDuckDb()` rejects with
  `Worker is not defined`. Use `@statewalker/db-duckdb-node` there.
- **Dependencies:** `@duckdb/duckdb-wasm` (the engine), `@statewalker/db-api`
  (the interface types).

## License

MIT
