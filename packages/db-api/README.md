# @statewalker/db-api

Minimal database client interface — query, execute, transaction primitives — consumed by every `@statewalker/db-*` driver.

## Installation

```sh
pnpm add @statewalker/db-api
```

## Usage

```ts
import type { DbClient } from "@statewalker/db-api";

async function listUsers(db: DbClient) {
  return db.query("SELECT id, name FROM users");
}
```

## API

- `DbClient` — driver-agnostic interface: `query`, `execute`, `transaction`.
- `Row`, `QueryResult` — result-shape types returned by drivers.

## Related

- `@statewalker/db-duckdb-browser` / `@statewalker/db-duckdb-node` — DuckDB drivers.
- `@statewalker/db-sqlite-browser` / `@statewalker/db-sqlite-node` — libSQL/SQLite drivers.
