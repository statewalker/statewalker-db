# @statewalker/db-sqlite-node

libSQL/SQLite Node.js driver implementing `@statewalker/db-api`, backed by `@libsql/client`.

## Installation

```sh
pnpm add @statewalker/db-sqlite-node
```

## Usage

```ts
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

// In-memory (omit `path`) or file-backed persistence.
const db = await newNodeSqliteDb({ path: "./data.db" });
await db.exec("CREATE TABLE t (x INTEGER)");
await db.query("SELECT * FROM t");
```

## API

- `newNodeSqliteDb(options?)` — opens a local file-backed (`options.path`) or in-memory libSQL database and returns a `Db`.

> Note: the underlying `@libsql/client` also supports remote Turso-cloud connections
> (`libsql://…turso.io` + `authToken`). That is a libSQL/Turso *product* feature and is
> out of scope for this package, which targets local/in-memory SQLite.

## Related

- `@statewalker/db-api` — interface contract.
- `@statewalker/db-sqlite-browser` — Browser-side counterpart.
