# @statewalker/db-sqlite-browser

## What it is

A libSQL/SQLite driver for the browser that implements `Db` from
`@statewalker/db-api`. It runs `@libsql/libsql-wasm-experimental`, a
WebAssembly build of libSQL that includes FTS5 full-text search and libSQL
vector search (`F32_BLOB`, `vector32`, `libsql_vector_idx`, `vector_top_k`).

## Why it exists

It gives browser code SQLite with full-text and vector search behind the same
`Db` interface that `@statewalker/db-sqlite-node` provides in Node.js, so
search and storage code runs unchanged in both places.

## How to use

```sh
pnpm add @statewalker/db-sqlite-browser
```

You must serve the engine's `sqlite3.wasm`. It is in
`@libsql/libsql-wasm-experimental/sqlite-wasm/jswasm/`. The driver loads it
from `/sqlite3.wasm` unless you pass `wasmUrl`.

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-browser` | `newBrowserSqliteDb`, type `BrowserDbOptions`; types `Db`, `DbEntry`, `DbOptions` re-exported from `@statewalker/db-api` | browser |

`newBrowserSqliteDb(options?)` returns `Promise<Db>`.

- `options.wasmUrl`: URL of `sqlite3.wasm`. Default `"/sqlite3.wasm"`.
- `options.path`: database name passed to the engine. Default `:memory:`.

The `Db` implements `query`, `exec` and `close`; it has no `flush`. Use `?`
placeholders.

## Examples

Full-text search:

```ts
import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";

const db = await newBrowserSqliteDb({ wasmUrl: "/assets/sqlite3.wasm" });
await db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
await db.exec("INSERT INTO docs (rowid, content) VALUES (1, 'hello world')");
const hits = await db.query<{ content: string }>(
  "SELECT content FROM docs WHERE docs MATCH ?",
  ["hello"],
);
await db.close();
```

Vector search:

```ts
import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";

const db = await newBrowserSqliteDb();
await db.exec("CREATE TABLE emb (id INTEGER PRIMARY KEY, vec F32_BLOB(3))");
await db.exec("CREATE INDEX emb_idx ON emb (libsql_vector_idx(vec))");
await db.exec("INSERT INTO emb VALUES (1, vector32('[1,0,0]')), (2, vector32('[0,1,0]'))");
const nearest = await db.query<{ id: number }>(
  "SELECT e.id FROM vector_top_k('emb_idx', '[1,0.1,0]', 1) AS v JOIN emb e ON e.rowid = v.id",
);
```

## Internals

- **The engine loads once per page.** The first call starts the WASM module;
  later calls reuse it, and their `wasmUrl` is ignored. A failed start is
  cached too: if `sqlite3.wasm` was not found, every later call in that page
  fails the same way until the page reloads.
- **No OPFS.** `options.path` goes to `new sqlite3.oo1.DB(path, "c")`. The
  driver does not install or select an OPFS VFS.
- **Synchronous engine, async interface.** `query` runs
  `db.exec(sql, { rowMode: "object", returnValue: "resultRows", bind })` on the
  calling thread; the `Db` methods are `async` only to match the interface.
  Long queries block the thread they run on.
- **Under Node.js** the module imports, but `newBrowserSqliteDb()` aborts with
  `ENOENT ... '/sqlite3.wasm'`. Use `@statewalker/db-sqlite-node` there.
- **Dependencies:** `@libsql/libsql-wasm-experimental` (the engine),
  `@statewalker/db-api` (the interface types).

## License

MIT
