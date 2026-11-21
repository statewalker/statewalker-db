# @statewalker/db-sqlite

## What it is

Transactions for SQLite databases behind `Db` from `@statewalker/db-api`:
`inTransaction(db, cb)` runs `cb` so that every statement issued through its `tx` handle commits
together or not at all; `inReadOnlyTransaction(db, cb)` runs it in a transaction that is always
rolled back, so nothing it writes persists. It also holds `newSerialisedSqliteDb`, the wrapper every SQLite driver
(`db-sqlite-node`, `db-sqlite-browser`, `db-sqlite-do`) builds its `Db` with, and
`newSerialisedDb`, the engine-neutral lifecycle wrapper the DuckDB and PGlite drivers use. Both
keep the lifecycle that the `Db` JSDoc in `@statewalker/db-api` promises.

## Why it exists

`Db` has no transaction method, and SQLite runtimes disagree on how to open one: Node.js and the
browser accept `BEGIN IMMEDIATE`, while a Durable Object rejects `BEGIN` ("not authorized") and
only offers `storage.transaction(async fn)`. Keeping transactions here leaves `Db` unchanged for
every engine, and gives SQLite callers one call that works in all three runtimes.

## How to use

```sh
pnpm add @statewalker/db-sqlite
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite` | `inTransaction`, `inReadOnlyTransaction`, `hasReadOnlyTransaction`, `newSerialisedDb`, `newSerialisedSqliteDb`, `SQLITE_TRANSACTION`, `SQLITE_READ_ONLY_TRANSACTION`; types `SerialisedDbEngine`, `SqliteEngine`, `SqliteTransactionHook` | any |

`newSerialisedDb(engine, { name })` wraps an asynchronous `SerialisedDbEngine` (`query(sql,
params)`, `exec(sql)`, optional `flush()`, `close()`) as a `Db`: calls run one at a time in call
order; `close()` waits for the calls made before it, then closes the engine once; a call made once
`close()` has started rejects with `<name>: the database is closed`; a second `close()` is a
no-op; integers in rows come back as numbers within ±(2^53 - 1) and as bigints beyond, also
inside arrays and plain objects. It lives here, not in `@statewalker/db-api`, because that
package is types-only; it has no SQLite code in it, so a DuckDB or PGlite driver depends on this
package without pulling in any engine.

`inTransaction(db, cb)` returns what `cb` returns. If `cb` throws, everything it wrote is rolled
back and the same error is rethrown; so is a failing `COMMIT` (a deferred foreign key, for
example), which rejects with SQLite's error. While it runs, other calls on `db` wait for it.

`inReadOnlyTransaction(db, cb)` returns what `cb` returns, or rethrows its error, and in both
cases rolls back everything it wrote: `tx` sees the committed data and its own writes, and none
of them persist. It is what a reader gets the full SQL surface through without the risk
(`@statewalker/db-rpc`'s read-only server uses it for every call). Two rules keep a statement from
slipping out of the transaction:
- SQL that would end the transaction or reach outside it is refused before it runs, on `query`
  and `exec` alike: a statement starting with BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE,
  ATTACH, DETACH, PRAGMA or VACUUM rejects with
  `db-sqlite: a read-only transaction refuses COMMIT (it would end the transaction or reach outside it)`.
  Statements are split as SQLite splits them, so the words inside literals, comments and trigger
  bodies do not count. A statement that does not start with a word (such as `(SELECT 1)`) is
  refused too, so that a separator SQLite skips and the splitter might not can never hide the
  word that starts it. The splitter follows SQLite's tokenizer where it matters: whitespace
  includes `\v`, and a Tcl-style variable (`$a(…)`, `:a(…)`, `@a(…)`, `#a(…)`) runs to the first
  `)` or whitespace, quotes included.
- `exec` inside it runs one statement per engine call, each through the engine's `all`. On
  Node.js, `all` compiles only the first statement of what it is given, so even text the splitter
  misreads as part of a statement never runs as a statement of its own. The browser engine's
  `all` runs every statement of its text, so there the splitter is the only guard; on a Durable
  Object the platform itself refuses transaction control in SQL.
- Once a statement fails, `tx` refuses every later call, with
  `db-sqlite: a statement of this read-only transaction failed, so it refuses later calls (SQLite may have ended the transaction)`:
  SQLite ends a transaction itself on some errors (`INSERT OR ROLLBACK`, `RAISE(ROLLBACK)`), and
  what ran after that would run, and persist, outside it.

`hasReadOnlyTransaction(db)` tells whether `db` carries the hook it needs.

Every SQLite driver handles input the same way, because the wrapper does it before the engine
sees the call (on the Db and on the `tx` handle alike):

| Input | Result |
| --- | --- |
| `query` with more than one statement (`"INSERT …; SELECT …"`) | rejects with `db-sqlite: query runs one statement, and this SQL has more after the first; …`; none of it runs. Use `exec` for scripts |
| empty SQL in `query` or `exec` (only whitespace, comments or `;`) | rejects with `db-sqlite: the SQL is empty (only whitespace, comments or semicolons)` |
| `true` / `false` parameter | binds `1` / `0` |
| `undefined` parameter | binds `NULL` |
| `Date` parameter | binds its ISO 8601 UTC text, `date.toISOString()` (`"2026-01-02T03:04:05.006Z"`), which SQLite date functions read; an invalid Date rejects with `db-sqlite: parameter N is an invalid Date` |
| `bigint` parameter | binds as an integer |
| `null`, `number`, `string` parameter | binds as given (an integer-valued number as an integer, any other as a real) |
| `ArrayBuffer`, or any ArrayBuffer view (`Uint8Array`, `DataView`, `Float32Array`, …) parameter | binds a BLOB of exactly the view's bytes (`byteOffset` to `byteOffset + byteLength`) |
| any other parameter: a plain object, `Map`, array, function, symbol, boxed primitive (`new String(…)`) | rejects with a `TypeError`, `db-sqlite: parameter N has type <type>, which SQLite cannot bind; …`, and nothing runs. node:sqlite would otherwise read a leading object as named parameters and bind the rest one place to the left. SQLite has no array type: bind a list as JSON text, `JSON.stringify(ids)`, and read it with `json_each(?)` |
| integer in a result | a `number` within ±(2^53 - 1), a `bigint` beyond, so no value loses precision |

A trailing `;`, comments, and semicolons inside literals or a `CREATE TRIGGER … BEGIN … END` body
do not count as a second statement. Parameter indexes in messages count from 1.

## Examples

```ts
import { inTransaction } from "@statewalker/db-sqlite";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

const db = await newNodeSqliteDb({ path: "./data.db" });
await db.exec(`
  CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, body TEXT);
  CREATE TABLE IF NOT EXISTS log (doc_id INTEGER);
`);
const id = await inTransaction(db, async (tx) => {
  const [row] = await tx.query<{ id: number }>("INSERT INTO docs (body) VALUES (?) RETURNING id", ["x"]);
  await tx.query("INSERT INTO log (doc_id) VALUES (?)", [row?.id]);
  return row?.id;
});
await db.close();
```

## Internals

- **Read-only rollback.** On Node.js and in the browser the transaction is `BEGIN` (deferred)
  … `ROLLBACK`; a `ROLLBACK` failing with `no transaction is active` (SQLite already ended it) is
  ignored, any other failure rejects. On a Durable Object, whose `storage.transaction` commits
  when the closure returns, the closure throws a marker error after `cb` returns, so the platform
  rolls back, and the marker is turned back into `cb`'s value. The read-only hook has its own key,
  `Symbol.for("@statewalker/db-sqlite:read-only-transaction")`, so a Db built by an older
  db-sqlite (which has only the committing hook) is refused, never committed:
  `inReadOnlyTransaction: this Db has no SQLite read-only transaction hook. ...`.
- **The hook travels on the Db object.** `newSerialisedSqliteDb` stores the transaction function
  under `Symbol.for("@statewalker/db-sqlite:transaction")`; `inTransaction` looks it up. A Db
  without it rejects with
  `inTransaction: this Db has no SQLite transaction hook. ...`. That happens for a DuckDB or PGlite
  Db, for **an object that wraps a SQLite Db** (copying `query`/`exec`/`close` drops the hook —
  pass the driver's Db, or a spread copy `{ ...db }`, which keeps symbol keys), and for the `tx`
  handle itself: **nested transactions are not supported**.
- **One call at a time.** Every `query`, `exec`, `close` and transaction goes through one queue
  (the one `newSerialisedDb` uses), in call order. A call made once `close()` has started rejects
  at once with `db-sqlite: the database is closed`; `close()` itself waits for earlier calls,
  and a second `close()` is a no-op. A plain `db.exec` issued while another flow's transaction is open waits; it never
  joins that transaction, so a rollback cannot take it down. `close` waits for a running
  transaction.
- **The `tx` handle expires.** After the callback settles, `tx.query` rejects with
  `db-sqlite: the transaction is finished; use the outer Db`; `tx.close` always rejects, with
  `db-sqlite: close the outer Db, not the transaction handle`.
- **Inside `cb`, use only `tx`.** Calling the outer `db` (`db.query`, or `inTransaction(db, ...)`)
  from inside `cb` queues behind the very transaction it belongs to, so the call never resolves
  and no error is raised. Nothing detects this at runtime.
- **Callback rules.** No external I/O inside `cb` (the queue is held for its whole duration), and
  `cb` must be idempotent: a Durable Object can run it more than once.
- **Row counts.** There is no "rows changed" result: use `SELECT changes()` or `RETURNING` inside
  the transaction. Id lists longer than 100 go in one JSON parameter through `json_each(?)` —
  Durable Objects reject more than 100 bound parameters with `too many SQL variables`.
- **`SqliteEngine` is the driver seam.** `all` is given one non-empty statement with normalised
  parameters, and returns BLOBs as `Uint8Array` and integers as numbers or bigints (an engine
  should read an integer above 2^53 as a bigint rather than throw; the wrapper turns safe ones into
  numbers); `exec` must run every statement of a non-empty string; `transaction` is given only by
  engines that cannot run `BEGIN IMMEDIATE`.
- **How the statements are counted.** `query` checks its SQL with a port of SQLite's own
  `sqlite3_complete()` scanner (literals, quoted identifiers, comments, trigger bodies), not by
  splitting on `;`.
- **Dependencies:** `@statewalker/db-api` (types only).

## License

MIT
