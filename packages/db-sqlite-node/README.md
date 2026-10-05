# @statewalker/db-sqlite-node

libSQL/SQLite driver for [`@statewalker/db-api`](../db-api), for Node.js. It
uses `@libsql/client` with a local file or an in-memory database. libSQL
includes FTS5 and vector search (`F32_BLOB`, `vector32`, `libsql_vector_idx`,
`vector_top_k`).

## Install

```sh
pnpm add @statewalker/db-sqlite-node
```

`@libsql/client` and `@statewalker/db-api` are regular dependencies; no peer
dependencies.

## Entry points

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-node` | `newNodeSqliteDb`; re-exports types `Db`, `DbEntry`, `DbOptions` | Node.js |

The package also ships its TypeScript sources in `src/`.

## Usage

```ts
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

const db = await newNodeSqliteDb({ path: "./data.db" }); // omit path for in-memory
await db.exec("CREATE TABLE t (x INTEGER)");
await db.exec("INSERT INTO t VALUES (1), (2)");
const rows = await db.query<{ x: number }>("SELECT x FROM t WHERE x > ?", [1]);
await db.close();
```

## API

- `newNodeSqliteDb(options?: DbOptions): Promise<Db>` opens `file:<path>`, or
  `:memory:` when no path is given.
- The returned `Db` implements `query`, `exec` and `close` (no `flush`).
- Parameters use `?` placeholders. Rows are libSQL `Row` objects: named columns
  plus non-enumerable positional keys. Spread a row (`{ ...row }`) to get a
  plain object.

Remote Turso connections (`libsql://` URLs with an auth token), which
`@libsql/client` supports, are not exposed by this package.

## Related

- [`@statewalker/db-api`](../db-api): the `Db` interface.
- [`@statewalker/db-sqlite-browser`](../db-sqlite-browser): the browser counterpart.
