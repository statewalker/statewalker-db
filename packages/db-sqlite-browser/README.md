# @statewalker/db-sqlite-browser

## What it is

A SQLite driver for the browser that implements `Db` from `@statewalker/db-api` on the official
WebAssembly build, `@sqlite.org/sqlite-wasm` (SQLite 3.53, FTS5 with the `unicode61`, `porter`
and `trigram` tokenizers). It opens an in-memory database anywhere, and a persistent database in
the origin-private file system (OPFS) from a Dedicated Worker. Its Db works with `inTransaction`
from `@statewalker/db-sqlite`.

## Why it exists

It lets code written against `Db` run on SQLite in the browser with the same SQL as on Node.js
(`@statewalker/db-sqlite-node`) and in Durable Objects (`@statewalker/db-sqlite-do`), so search
and storage code is written and tested once.

## How to use

```sh
pnpm add @statewalker/db-sqlite-browser
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-browser` | `newBrowserSqliteDb`; types `BrowserDbOptions`, `Db`, `DbEntry`, `DbOptions` | browser: main thread (in-memory) or Dedicated Worker (OPFS); Node.js (in-memory) |

`newBrowserSqliteDb({ path?, wasmUrl? })` returns `Promise<Db>`. Without `path` the database is
in memory; that also works under Node.js (where a `wasmUrl`, if given, is a file path). With
`path` it lives in OPFS through the `opfs-sahpool` VFS, which works only in a Dedicated Worker.
Use `?` placeholders. Bundlers must not pre-bundle `@sqlite.org/sqlite-wasm` (Vite:
`optimizeDeps.exclude`), or pass `wasmUrl`.

## Examples

```ts
// worker.ts — started with new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";

const db = await newBrowserSqliteDb({ path: "/notes.db" });
await db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(body)");
const hits = await db.query("SELECT rowid FROM notes WHERE notes MATCH ?", ["sqlite"]);
```

## Internals

- **Why OPFS only in a Dedicated Worker.** `opfs-sahpool` uses synchronous OPFS access handles,
  which browsers provide only in workers. It needs no `SharedArrayBuffer`, so no COOP/COEP
  headers. Outside a Dedicated Worker (the main thread, Node.js) a `path` rejects at once with
  `newBrowserSqliteDb: { path } needs a Dedicated Worker ...` rather than falling back to memory.
- **One worker owns a database.** The pool holds its OPFS files open while the worker lives; a
  second worker (or tab) opening the same `path` fails with an OPFS lock error until the first
  one is terminated.
- **The pool has room for a few files.** Its default capacity is 6 files, and each database also
  uses journal files, so a worker that opens many databases can run out of slots.
- **Calls are queued** and transactions open with `BEGIN IMMEDIATE` (see `@statewalker/db-sqlite`).
  Rows are plain objects; BLOBs are `Uint8Array`.
- **The engine loads once per `wasmUrl`.** A failed load (for example a wrong `wasmUrl`) is not
  retried for that URL.
- **Dependencies:** `@sqlite.org/sqlite-wasm` (the engine), `@statewalker/db-sqlite` (queue and
  transactions), `@statewalker/db-api` (types).

## License

MIT
