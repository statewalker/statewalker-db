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

`newBrowserSqliteDb({ path?, wasmUrl?, capacity? })` returns `Promise<Db>`. Without `path` the
database is in memory; that also works under Node.js (where a `wasmUrl`, if given, is a file path).
With `path` it lives in OPFS through the `opfs-sahpool` VFS, which works only in a Dedicated Worker.
`capacity` raises the number of files that VFS can hold (see below).
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

```ts
// A worker that keeps one database per project: reserve room before the default 6 files run out.
const projectId = "p1";
const db = await newBrowserSqliteDb({ path: `/projects/${projectId}.db`, capacity: 64 });
```

## How many databases fit: the pool holds a fixed number of files

`opfs-sahpool` keeps a pool of OPFS files open for as long as the worker lives, and every file
SQLite creates takes one: each database file, whether open or closed, and its rollback journal
while a write transaction runs. The pool starts with **6** files, so a worker can keep about
five databases if their writes do not overlap.

- **What a full pool looks like.** Creating a database, or the journal of its next write, fails with
  `SQLITE_CANTOPEN: sqlite3 result code 14: unable to open database file`. It looks like a bad path
  or a locking problem, but it is the pool running out of files. Opening a database that already
  exists needs no new file.
- **`capacity` reserves room.** It is the minimum number of files in the pool. It is stored in OPFS
  with the pool, never shrinks, and costs one open file handle per slot from the moment the worker
  starts, used or not, which is why the default is small. Size it at about two files per database
  (the database and its journal), plus a few spare; tens are cheap, hundreds slow the start.
- **Closing a database does not free its file.** The data stays in the pool until the file is
  deleted, and this driver does not delete files.
- **One pool per worker.** All databases a worker opens share the pool, and `capacity` applies to
  that pool. Each call that passes `capacity` grows it if needed.

## Internals

- **Why OPFS only in a Dedicated Worker.** `opfs-sahpool` uses synchronous OPFS access handles,
  which browsers provide only in workers. It needs no `SharedArrayBuffer`, so no COOP/COEP
  headers. Outside a Dedicated Worker (the main thread, Node.js) a `path` rejects at once with
  `newBrowserSqliteDb: { path } needs a Dedicated Worker ...` rather than falling back to memory.
- **One worker owns a database.** The pool holds its OPFS files open while the worker lives; a
  second worker (or tab) opening the same `path` fails with an OPFS lock error until the first
  one is terminated.
- **Calls are queued** and transactions open with `BEGIN IMMEDIATE` (see `@statewalker/db-sqlite`).
  Rows are plain objects; BLOBs are `Uint8Array`.
- **The engine loads once per `wasmUrl`.** A failed load (for example a wrong `wasmUrl`) is not
  retried for that URL.
- **Dependencies:** `@sqlite.org/sqlite-wasm` (the engine), `@statewalker/db-sqlite` (queue and
  transactions), `@statewalker/db-api` (types).

## License

MIT
