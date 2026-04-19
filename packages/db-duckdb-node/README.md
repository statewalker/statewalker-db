# @statewalker/db-duckdb-node

DuckDB Node.js driver implementing `@statewalker/db-api`, backed by `@duckdb/node-api`.

## Installation

```sh
pnpm add @statewalker/db-duckdb-node
```

## Usage

```ts
import { createDuckDbNodeClient } from "@statewalker/db-duckdb-node";

const db = await createDuckDbNodeClient({ path: "./data.duckdb" });
await db.execute("CREATE TABLE t (x INTEGER)");
```

## API

- `createDuckDbNodeClient(options)` — opens an on-disk or in-memory DuckDB file and returns a `DbClient`.

## Related

- `@statewalker/db-api` — interface contract.
- `@statewalker/db-duckdb-browser` — Browser-side counterpart.
