# @statewalker/db-turso-browser

Turso / libSQL WASM driver implementing `@statewalker/db-api` for browser environments.

## Installation

```sh
pnpm add @statewalker/db-turso-browser
```

## Usage

```ts
import { createTursoBrowserClient } from "@statewalker/db-turso-browser";

const db = await createTursoBrowserClient({ url: "file:local.db" });
await db.execute("CREATE TABLE t (x INTEGER)");
```

## API

- `createTursoBrowserClient(options)` — opens a libSQL-WASM instance and returns a `DbClient`.

## Related

- `@statewalker/db-api` — interface contract.
- `@statewalker/db-turso-node` — Node-side counterpart.
