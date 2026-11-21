# @statewalker/db-sqlite

## 0.1.4

### Patch Changes

- 5405c85: Adds `inReadOnlyTransaction(db, cb)`: runs `cb` in a transaction that is always rolled back, on Node.js, in the browser and on a Durable Object, returning `cb`'s value or rethrowing its error; nothing written inside persists. Statements that would end the transaction or reach outside it (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE, ATTACH, DETACH, PRAGMA, VACUUM, or a statement not starting with a keyword) are refused, and once a statement fails the handle refuses later calls, since SQLite can end a transaction itself (`INSERT OR ROLLBACK`). Also adds `hasReadOnlyTransaction(db)` and the hook's key `SQLITE_READ_ONLY_TRANSACTION`.

## 0.1.3

### Patch Changes

- a1a5c00: Adds `newSerialisedDb(engine, { name })` and the `SerialisedDbEngine` type: the engine-neutral lifecycle wrapper (one call at a time in call order, `close()` waits for earlier calls, later calls reject with `<name>: the database is closed`, closing twice is a no-op, safe integers as numbers) that the DuckDB and PGlite drivers now share with `newSerialisedSqliteDb`. SQLite Dbs now reject a call made after `close()` has started at once instead of after the queue drains (same error).
- e70e7fd: Reject a parameter SQLite cannot bind (a plain object, `Map`, array, function, symbol or boxed primitive) with a `TypeError` naming its 1-based index and type, before anything runs, on the Db and on the transaction handle. db-sqlite-node and db-sqlite-do used to drop a leading object and bind the other parameters one column to the left. An `ArrayBuffer` and every ArrayBuffer view (`DataView`, `Float32Array`, …) now bind as a BLOB of exactly their bytes on every SQLite driver.
- Updated dependencies [a1a5c00]
  - @statewalker/db-api@0.1.7

## 0.1.2

### Patch Changes

- 9e4d9ca: Add a `default` export condition next to `import`, so CommonJS consumers can `require()` the ESM build (Node 20.19+, 22.12+).
- 1ca4b05: `query` passes only the statement itself to the engine, without its ending semicolon and empty tail: Durable Object SQLite rejected `SELECT 1; -- comment` with "SQL code did not contain a statement".
- 7f9f827: Every SQLite driver now handles input the same way. `query` rejects SQL with a second statement
  before running any of it (node ran only the first, the browser and the DO fake ran all of them),
  and `query` and `exec` reject empty SQL with `db-sqlite: the SQL is empty …`. Parameters are
  normalised: `true`/`false` bind as `1`/`0`, `undefined` as `NULL`, and a `Date` as its ISO 8601
  UTC text (an invalid Date rejects). An integer above 2^53 in a result comes back as an exact
  `bigint` on node and the DO fake too, as it already did in the browser; smaller ones stay numbers.
- bcc48c6: Stop publishing test files: `files` now excludes `src/**/*.test.ts` (and, in db-sqlite-index, `src/**/test-fixtures.ts`), and db-sqlite-index's Durable Object smoke scenarios moved out of `src/`. The published code is unchanged.
- Updated dependencies [9e4d9ca]
- Updated dependencies [bcc48c6]
  - @statewalker/db-api@0.1.6

## 0.1.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/db-api ^0.1.4 -> ^0.1.5

## 0.1.0

### Minor Changes

- 4f7f4c9: New package: `inTransaction(db, cb)` for SQLite `Db`s and `newSerialisedSqliteDb(engine)`, the queue + transaction-hook wrapper all SQLite drivers share.

### Patch Changes

- Updated dependencies
  - @statewalker/db-api@0.1.4
