# @statewalker/db-turso-node

Turso / libSQL Node.js driver implementing `@statewalker/db-api`, backed by `@libsql/client`.

## Installation

```sh
pnpm add @statewalker/db-turso-node
```

## Usage

```ts
import { createTursoNodeClient } from "@statewalker/db-turso-node";

const db = await createTursoNodeClient({ url: "libsql://example.turso.io", authToken: "…" });
await db.execute("CREATE TABLE t (x INTEGER)");
```

## API

- `createTursoNodeClient(options)` — opens a remote or local libSQL connection and returns a `DbClient`.

## Related

- `@statewalker/db-api` — interface contract.
- `@statewalker/db-turso-browser` — Browser-side counterpart.
