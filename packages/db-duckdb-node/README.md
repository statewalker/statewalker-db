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

- **One instance, one connection.** The factory creates a `DuckDBInstance`
  and a single connection; `close()` closes both synchronously.
- **Parameters.** With parameters, `query` prepares the statement, binds the
  array and runs it. Both `$1` and `?` placeholders work.
- **Rows are plain JS objects** (`getRowObjectsJS()`). DuckDB `BIGINT` values,
  including `count(*)`, come back as `bigint`, not `number`.
- **Errors are DuckDB's.** A bad path rejects with
  `IO Error: Cannot open file "...": No such file or directory`. Bad SQL rejects
  with `Parser Error: ...`. A call after `close()` rejects with
  `Failed to query: connection disconnected`.
- **Dependencies:** `@duckdb/node-api` (the engine), `@statewalker/db-api`
  (the interface types).

## License

MIT
