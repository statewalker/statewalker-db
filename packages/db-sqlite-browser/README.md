# @statewalker/db-sqlite-browser

libSQL/SQLite driver for [`@statewalker/db-api`](../db-api), for the browser.
It uses `@libsql/libsql-wasm-experimental`, a WebAssembly build of libSQL with
FTS5 and libSQL vector search (`F32_BLOB`, `vector32`, `libsql_vector_idx`,
`vector_top_k`).

## Install

```sh
pnpm add @statewalker/db-sqlite-browser
```

`@libsql/libsql-wasm-experimental` and `@statewalker/db-api` are regular
dependencies; no peer dependencies.

You must serve the engine's `sqlite3.wasm` file. By default the driver loads it
from `/sqlite3.wasm`; pass `wasmUrl` to change that. The file is in
`@libsql/libsql-wasm-experimental/sqlite-wasm/jswasm/`.

## Entry points

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-browser` | `newBrowserSqliteDb`, type `BrowserDbOptions`; re-exports types `Db`, `DbEntry`, `DbOptions` | browser |

The package also ships its TypeScript sources in `src/`.

## Usage

```ts
import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";

const db = await newBrowserSqliteDb({ wasmUrl: "/assets/sqlite3.wasm" });
await db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
await db.exec("INSERT INTO docs (rowid, content) VALUES (1, 'hello world')");
const rows = await db.query<{ content: string }>(
  "SELECT content FROM docs WHERE docs MATCH ?",
  ["hello"],
);
await db.close();
```

## API

- `newBrowserSqliteDb(options?: BrowserDbOptions): Promise<Db>`
  - `options.path`: database file name passed to the engine. Omit it for
    `:memory:`.
  - `options.wasmUrl`: URL of `sqlite3.wasm`. Default `"/sqlite3.wasm"`.
- The engine is initialized once per page. Later calls reuse it, and the
  `wasmUrl` of the first call wins.
- The returned `Db` implements `query`, `exec` and `close` (no `flush`).
- Parameters use `?` placeholders.

## Related

- [`@statewalker/db-api`](../db-api): the `Db` interface.
- [`@statewalker/db-sqlite-node`](../db-sqlite-node): the Node.js counterpart.
