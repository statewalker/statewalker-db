# @statewalker/db-sqlite

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
