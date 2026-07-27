# @statewalker/db-sqlite-browser

libSQL/SQLite WASM driver implementing `@statewalker/db-api` for browser environments,
backed by `@libsql/libsql-wasm-experimental` (FTS5 + vector search compiled to WebAssembly).

## Installation

```sh
pnpm add @statewalker/db-sqlite-browser
```

## Usage

```ts
import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";

// In-memory (omit `path`) or file-backed; `wasmUrl` locates sqlite3.wasm (default "/sqlite3.wasm").
const db = await newBrowserSqliteDb({ path: "local.db" });
await db.exec("CREATE TABLE t (x INTEGER)");
await db.query("SELECT * FROM t");
```

## API

- `newBrowserSqliteDb(options?)` — initializes the libSQL-WASM engine and returns a `Db`.
  `options.path` selects file-backed vs in-memory; `options.wasmUrl` locates the `sqlite3.wasm` asset.

## Related

- `@statewalker/db-api` — interface contract.
- `@statewalker/db-sqlite-node` — Node-side counterpart.
