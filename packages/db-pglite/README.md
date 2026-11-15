# @statewalker/db-pglite

## What it is

A driver that implements `Db` from `@statewalker/db-api` on PGlite, Postgres compiled to
WebAssembly, in Node.js or in the browser. Extensions such as pgvector are passed in by the
caller.

## Why it exists

Postgres-backed code (full-text search with `tsvector`, pgvector indexes) can then take a `Db`
like every other engine here, instead of a `PGlite` instance, and be tested with the same
conformance suite.

## How to use

```sh
pnpm add @statewalker/db-pglite @electric-sql/pglite
pnpm add @electric-sql/pglite-pgvector   # only for the pgvector example below
```

`@electric-sql/pglite` (`^0.5.15`) is a peer dependency: install it yourself, so the driver and
the extensions you pass share one PGlite. Pick the PGlite version your extensions are built for
(`@electric-sql/pglite-pgvector@0.0.16` needs PGlite `0.5.15`, `0.0.17` needs `0.5.16`).

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-pglite` | `newPgliteDb`; types `PgliteDbOptions`, `Db`, `DbEntry` | Node.js, browser |

`newPgliteDb({ path?, extensions? })` returns `Promise<Db>`. Use `$1`, `$2`, ... placeholders.
`exec` runs several statements; `query` runs one, with parameters.

## Examples

```ts
import { vector } from "@electric-sql/pglite-pgvector";
import { newPgliteDb } from "@statewalker/db-pglite";

const db = await newPgliteDb({ path: "./pgdata", extensions: { vector } });
await db.exec("CREATE EXTENSION IF NOT EXISTS vector");
const rows = await db.query("SELECT $1::int + 1 AS n", [41]);
```

## Internals

- **`path` is a PGlite data directory**, not a file: a folder on Node.js, `idb://<name>`
  (IndexedDB) in a browser. Omit it for an in-memory database. This package's tests run on
  Node.js only.
- **The caller owns extensions.** The driver loads what it is given and never runs
  `CREATE EXTENSION`; do that after opening.
- **No transactions helper.** `inTransaction` from `@statewalker/db-sqlite` is SQLite-only and
  rejects this Db. Postgres runs `BEGIN ... COMMIT` as ordinary SQL inside one `exec`.
- **After `close()`** every call rejects with `db-pglite: the database is closed`; a second
  `close()` does nothing.
- **Dependencies:** `@statewalker/db-api` (types); peer `@electric-sql/pglite` (the engine,
  provided by the caller).

## License

MIT
