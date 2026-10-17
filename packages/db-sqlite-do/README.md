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

## Internals

- **Transactions use `storage.transaction(async fn)`.** It rolls back on a throw even after
  `await`s on timers or `fetch`. `transactionSync` is not used: given an async function it commits
  at the first `await`, so a later throw rolls nothing back. The platform may run the callback
  again, so it must be idempotent and do no external I/O.
- **Limits of DO SQLite, and what they look like:** more than 100 bound parameters rejects with
  `too many SQL variables` (pass id lists as one JSON string to `json_each(?)`); a BLOB or string
  over about 2 MB rejects with `string or blob too big`; `BEGIN`, `SAVEPOINT` and `PRAGMA` reject
  with `not authorized`. An operation that runs past the platform deadline (15 s on celld) is
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
