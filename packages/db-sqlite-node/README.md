# @statewalker/db-sqlite-node

## What it is

A SQLite driver for Node.js that implements `Db` from `@statewalker/db-api` on Node.js's
built-in `node:sqlite` (Node.js 22.13 or later; Node.js 24.21 bundles SQLite 3.53.4), with a
local file or an in-memory database.
Its Db works with `inTransaction` from `@statewalker/db-sqlite`. FTS5 is included, with the
`unicode61`, `porter` and `trigram` tokenizers.

## Why it exists

It lets code written against `Db` run on SQLite in Node.js, with the same SQL
features that `@statewalker/db-sqlite-browser` has in the browser. Search and
storage code can be built and tested in Node.js and shipped to the browser
unchanged. It needs no native addon or extra download, since the engine ships with Node.js.

## How to use

```sh
pnpm add @statewalker/db-sqlite-node
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-node` | `newNodeSqliteDb`; types `Db`, `DbEntry`, `DbOptions` re-exported from `@statewalker/db-api` | Node.js |

`newNodeSqliteDb(options?)` returns `Promise<Db>`. It opens `path`, or `:memory:` without one.
The `Db` implements `query`, `exec` and `close`; it has no `flush` (every commit is on disk).
Use `?` placeholders. Wrap related writes in `inTransaction(db, async (tx) => ...)` from
`@statewalker/db-sqlite`.

## Examples

```ts
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

const db = await newNodeSqliteDb({ path: "./data.db" });
await db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
await db.exec("INSERT INTO t VALUES (1), (2)");
const rows = await db.query<{ x: number }>("SELECT x FROM t WHERE x > ?", [1]);
await db.close();
```

## Internals

- **Calls are queued.** The Db runs one call at a time in call order, and opens transactions
  with `BEGIN IMMEDIATE` (see `@statewalker/db-sqlite`). `node:sqlite` is synchronous, so a long
  statement blocks the event loop while it runs.
- **`query` runs one statement.** SQL with a second statement rejects before anything runs, and
  empty SQL rejects; `true`/`false`, `undefined` and `Date` parameters bind as `1`/`0`, `NULL` and
  ISO 8601 text. All of it comes from `@statewalker/db-sqlite`, the same on every SQLite driver.
  Use `exec` for multi-statement scripts.
- **Rows are plain objects with a `null` prototype**, BLOBs are `Uint8Array`, integers are
  JavaScript numbers, except one above 2^53 (or below -2^53), which comes back as an exact
  `bigint`. Statements read integers with `setReadBigInts(true)`.
- **Errors are `node:sqlite`'s.** A path in a missing directory rejects with
  `unable to open database file`; bad SQL rejects with `near "...": syntax error`; a call after
  `close()` rejects with `db-sqlite: the database is closed`.
- **Node.js 22 prints `ExperimentalWarning: SQLite is an experimental feature`** on first use,
  because it still marks `node:sqlite` experimental. It is harmless; Node.js 24.21 prints
  nothing.
- **Dependencies:** `@statewalker/db-sqlite` (queue and transactions), `@statewalker/db-api`
  (types). The engine is part of Node.js.

## License

MIT
