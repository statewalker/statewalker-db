# @statewalker/db-duckdb-node

## What it is

A DuckDB driver for Node.js that implements `Db` from `@statewalker/db-api`.
It uses the native bindings from `@duckdb/node-api` and opens a DuckDB file or
an in-memory database.

## Why it exists

It lets code written against `Db` run on DuckDB in Node.js: servers, CLIs,
build scripts and tests. The same code runs in the browser on
`@statewalker/db-duckdb-browser`.

## How to use

```sh
pnpm add @statewalker/db-duckdb-node
```

`@duckdb/node-api` installs a prebuilt native binary for your platform.

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-duckdb-node` | `newNodeDuckDb`; types `Db`, `DbEntry`, `DbOptions` re-exported from `@statewalker/db-api` | Node.js |

`newNodeDuckDb(options?)` returns `Promise<Db>`. It opens `options.path`, or
`:memory:` without a path. The `Db` implements `query`, `exec` and `close`; it
has no `flush`.

## Examples

```ts
import { newNodeDuckDb } from "@statewalker/db-duckdb-node";

const db = await newNodeDuckDb({ path: "./data.duckdb" });
await db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
await db.exec("INSERT INTO t VALUES (1), (2)");
const rows = await db.query<{ x: number }>("SELECT x FROM t WHERE x > $1", [1]);
await db.close();
```

## Internals

- **One instance, one connection, one call at a time.** The factory creates a
  `DuckDBInstance` and a single connection, wrapped by `newSerialisedDb` from
  `@statewalker/db-sqlite` (the lifecycle every driver shares): calls run in
  call order, `close()` waits for the calls made before it and then closes
  both handles, later calls reject with
  `db-duckdb-node: the database is closed`, and a second `close()` is a no-op.
  Closing during a query used to fail it with `bad_weak_ptr` or crash the
  process.
- **Parameters.** With parameters, `query` prepares the statement, binds the
  array and runs it, then destroys the prepared statement. Both `$1` and `?`
  placeholders work. Supported parameter values:

  | JS value | Bound as |
  | --- | --- |
  | `null` | `NULL` |
  | `boolean` | `BOOLEAN` |
  | `number` | `INTEGER` (or `BIGINT` outside 32 bits) when integral, else `DOUBLE` |
  | `bigint` | `HUGEINT` |
  | `string` | `VARCHAR` |
  | `Uint8Array` (and `Buffer`) | `BLOB` |
  | `Date` | `TIMESTAMP` (UTC, microsecond precision), or `TIMESTAMPTZ` where the statement expects one (also as the items of a `TIMESTAMPTZ[]`), so the instant is kept whatever the session time zone; an invalid `Date` throws |
  | array, or a non-byte typed array such as `Float32Array` | `LIST`, recursively; the item type comes from all items, so `[0, 0.5]` is `DOUBLE[]` |

  DuckDB casts these to the column or the cast type, so an array binds into a
  `FLOAT[3]` or `INTEGER[]` column and `$1::FLOAT[3]` works. An empty array
  needs a known list type: a `LIST` column or a cast such as `$1::INTEGER[]`.
  Other `@duckdb/node-api` values (`DuckDBValue`) pass through unchanged.
  A `Date` keeps its instant in a `TIMESTAMPTZ` position only when DuckDB reports
  the parameter's type. It does not for a cast array subscripted in the same
  expression (`($1::TIMESTAMPTZ[2])[1]`): there, the Date binds as `TIMESTAMP` and
  is read in the session time zone. Bind into a column or cast without the subscript.
- **One statement per `query`.** `query` rejects SQL holding several
  statements (`query() runs one statement, ...`) instead of returning only the
  first one's rows; run scripts with `exec`.
- **Rows are plain JS objects** (`getRowObjectsJS()`), with the integers the
  `Db` contract asks for: a `number` within ±(2^53 - 1), a `bigint` beyond,
  whatever the column type (`BIGINT`, `UBIGINT`, `HUGEINT`, `count(*)`), also
  inside lists and structs. `TIME` (microseconds since midnight) and the
  `micros` of an `INTERVAL` follow the same rule. `DECIMAL` comes back as a
  `number` (the nearest double), `DATE` and `TIMESTAMP` as a `Date`, `BLOB` as
  a `Buffer` (a `Uint8Array`).
- **Errors are DuckDB's.** A bad path rejects with
  `IO Error: Cannot open file "...": No such file or directory`. Bad SQL rejects
  with `Parser Error: ...`. A call after `close()` rejects with
  `db-duckdb-node: the database is closed`.
- **Dependencies:** `@duckdb/node-api` (the engine), `@statewalker/db-api`
  (the interface types), `@statewalker/db-sqlite` (`newSerialisedDb`, the
  shared lifecycle wrapper; no SQLite engine comes with it).

## License

MIT
