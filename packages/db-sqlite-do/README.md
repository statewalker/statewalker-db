# @statewalker/db-sqlite-do

## What it is

A driver that implements `Db` from `@statewalker/db-api` on a Durable Object's SQLite storage
(`ctx.storage`), on Cloudflare or on celld. Its Db works with `inTransaction` from
`@statewalker/db-sqlite`. The `./fake` subpath gives a Node.js stand-in for `ctx.storage` with
the same limits, for unit tests.

## Why it exists

Code written against `Db` (search indexes, file stores) must run inside a Durable Object as it
does on Node.js and in the browser. DO SQLite differs in ways that break such code silently: SQL
`BEGIN` is rejected, `transactionSync` commits at the first `await`, BLOBs come back as
`ArrayBuffer`. This driver hides those differences behind the same `Db` and transaction call.

## How to use

```sh
pnpm add @statewalker/db-sqlite-do
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-do` | `newDoSqliteDb`; types `DoSqlStorage`, `DoSqlCursor` | Durable Object (Cloudflare, celld) |
| `@statewalker/db-sqlite-do/fake` | `newFakeDoStorage` | Node.js (tests) |

`newDoSqliteDb(storage)` returns a `Db` synchronously, so it can be created in the DO
constructor. Use `?` placeholders.

## Examples

```ts
import { DurableObject } from "cloudflare:workers";
import { inTransaction } from "@statewalker/db-sqlite";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";

export class Notes extends DurableObject {
  db = newDoSqliteDb(this.ctx.storage);

  async add(body: string) {
    await this.db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
    return inTransaction(this.db, (tx) =>
      tx.query<{ id: number }>("INSERT INTO notes (body) VALUES (?) RETURNING id", [body]),
    );
  }
}
```

In a Node.js test:

```ts
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";

const db = newDoSqliteDb(newFakeDoStorage());
```

## How it is tested against a real Durable Object

`pnpm test:do` (from the repository root) builds the workspace, starts `celld dev` on
`packages/db-sqlite-do/test-do/` with a clean state on a free port, and runs, inside a real
Durable Object, the shared `Db` conformance suite (through a small HTTP bridge), every scenario
listed in `test-do/scenarios.ts` (the SQLite transaction scenarios a DO can meet, plus the smoke scenarios other
packages register there), and a platform probe whose expectations the `./fake` must also meet. It
needs celld 0.6.x on `PATH`; with another version it stops at once with
`test:do needs celld 0.6.x on PATH, found "<version>"`. It stops only the celld process it
started. It is not part of `pnpm test`: run it before a release.

## Internals

- **Transactions use `storage.transaction(async fn)`.** It rolls back on a throw even after
  `await`s on timers or `fetch`. `transactionSync` is not used: given an async function it commits
  at the first `await`, so a later throw rolls nothing back. The platform may run the callback
  again, so it must be idempotent and do no external I/O.
- **Limits of DO SQLite, and what they look like:** more than 100 bound parameters rejects with
  `too many SQL variables` (pass id lists as one JSON string to `json_each(?)`); a BLOB or string
  over about 2 MB rejects with `string or blob too big` (the fake measures a string in UTF-8 bytes); `BEGIN`, `SAVEPOINT` and `PRAGMA` reject
  with `not authorized`.
- **`ON CONFLICT ROLLBACK` and `RAISE(ROLLBACK)` fail the whole DO call.** Inside `inTransaction`
  on a Durable Object, a statement that makes SQLite itself end the transaction rolls the data
  back, but the call in flight rejects with `a transaction rollback failed: … cannot rollback - no
  transaction is active` instead of the constraint error, and the DO instance is reset (observed
  on celld 0.6.2; Cloudflare unverified). Use the default `ABORT` conflict resolution inside
  transactions. The fake rejects with the same message, so `inTransaction` callers see it in unit
  tests too. An operation that runs past the platform deadline (15 s on celld) is
  retried rather than failed, so keep each write step small.
- **BLOBs are converted both ways.** Typed-array parameters are bound as `ArrayBuffer`;
  `ArrayBuffer` values read back become `Uint8Array`, as on every other SQLite driver.
- **`close()` releases nothing.** The storage belongs to the DO. It only makes later calls on this
  Db reject with `db-sqlite: the database is closed`.
- **Use one Db per DO.** Calls are queued inside one Db; direct `ctx.storage.sql` calls made
  elsewhere in the DO bypass that queue.
- **The fake is strict where the platform is unknown.** It rejects every `PRAGMA` (the platform
  allows a few) and typed-array BLOB parameters, so code that passes on the fake does not depend
  on them. Its limits are checked against real DO SQLite by `pnpm test:do`, which runs the same
  probe in a `celld dev` Durable Object.
- **Dependencies:** `@statewalker/db-sqlite` (queue and transactions), `@statewalker/db-api`
  (types). `./fake` uses Node.js's `node:sqlite`.

## License

MIT
