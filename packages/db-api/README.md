# @statewalker/db-api

The minimal database interface shared by all `@statewalker/db-*` drivers. Code
written against `Db` runs on DuckDB or SQLite, in the browser or in Node.js,
depending on which driver creates the instance. The package contains only
TypeScript types; it has no runtime code.

## Install

```sh
pnpm add @statewalker/db-api
```

No dependencies or peer dependencies.

## Entry points

| Import | Gives |
| --- | --- |
| `@statewalker/db-api` | Types `Db`, `DbEntry`, `DbOptions` (`dist/index.mjs`, `dist/index.d.mts`) |

The package also ships its TypeScript sources in `src/`.

## Usage

```ts
import type { Db } from "@statewalker/db-api";

async function listUsers(db: Db) {
  return db.query<{ id: number; name: string }>("SELECT id, name FROM users");
}
```

Get a `Db` from one of the drivers, for example `newNodeSqliteDb()` from
`@statewalker/db-sqlite-node`.

## API

- `Db`
  - `query<T = DbEntry>(sql, params?)` returns `Promise<T[]>`. `params` are
    positional; the placeholder syntax depends on the engine (`?` for SQLite,
    `$1` for DuckDB).
  - `exec(sql)` runs a statement that returns no rows (DDL, DML).
  - `flush?()` (optional) writes buffered changes to durable storage. Only
    backends that buffer implement it (for example DuckDB WASM on OPFS).
  - `close()` releases the database.
- `DbEntry` is `Record<string, unknown>`, the default row type.
- `DbOptions` is `{ path?: string }`: a file path (Node) or an OPFS path
  (browser). Omit it for an in-memory database.

## Related

- [`@statewalker/db-duckdb-browser`](../db-duckdb-browser),
  [`@statewalker/db-duckdb-node`](../db-duckdb-node): DuckDB drivers.
- [`@statewalker/db-sqlite-browser`](../db-sqlite-browser),
  [`@statewalker/db-sqlite-node`](../db-sqlite-node): libSQL/SQLite drivers.
