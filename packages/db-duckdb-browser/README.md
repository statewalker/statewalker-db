# @statewalker/db-duckdb-browser

DuckDB WASM driver implementing `@statewalker/db-api` for browser environments.

## Installation

```sh
pnpm add @statewalker/db-duckdb-browser
```

## Usage

```ts
import { createDuckDbBrowserClient } from "@statewalker/db-duckdb-browser";

const db = await createDuckDbBrowserClient();
await db.execute("CREATE TABLE t (x INTEGER)");
```

## API

- `createDuckDbBrowserClient(options?)` — spins up an in-browser DuckDB WASM instance and returns a `DbClient`.

## Related

- `@statewalker/db-api` — interface contract.
- `@statewalker/db-duckdb-node` — Node-side counterpart.
