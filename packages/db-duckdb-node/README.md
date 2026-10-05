# @statewalker/db-duckdb-node

DuckDB driver for [`@statewalker/db-api`](../db-api), for Node.js. It uses the
native bindings from `@duckdb/node-api` and returns a `Db` backed by a DuckDB
file or an in-memory database.

## Install

```sh
pnpm add @statewalker/db-duckdb-node
```

`@duckdb/node-api` and `@statewalker/db-api` are regular dependencies; no peer
dependencies. `@duckdb/node-api` installs a platform-specific native binary.

## Entry points

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-duckdb-node` | `newNodeDuckDb`; re-exports types `Db`, `DbEntry`, `DbOptions` | Node.js |

The package also ships its TypeScript sources in `src/`.

## Usage

```ts
import { newNodeDuckDb } from "@statewalker/db-duckdb-node";

const db = await newNodeDuckDb({ path: "./data.duckdb" }); // omit path for in-memory
await db.exec("CREATE TABLE t (x INTEGER)");
await db.exec("INSERT INTO t VALUES (1), (2)");
const rows = await db.query<{ x: number }>("SELECT x FROM t WHERE x > $1", [1]);
await db.close();
```

## API

- `newNodeDuckDb(options?: DbOptions): Promise<Db>` opens `options.path`, or
  `:memory:` when no path is given.
- The returned `Db` implements `query`, `exec` and `close` (no `flush`).
- Parameters use DuckDB placeholders (`$1`, `$2`, ...). Rows are plain JS
  objects (`getRowObjectsJS()`), so `BIGINT` values come back as `bigint`.

## Related

- [`@statewalker/db-api`](../db-api): the `Db` interface.
- [`@statewalker/db-duckdb-browser`](../db-duckdb-browser): the browser counterpart.
