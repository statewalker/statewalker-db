# @statewalker/db-sqlite-browser

## 0.2.4

### Patch Changes

- 5f748c9: Depend on `@statewalker/db-sqlite` ^0.1.3 and `@statewalker/db-api` ^0.1.7, the releases with the parameter validation (#25) and the shared lifecycle (#45).
- Updated dependencies [a1a5c00]
- Updated dependencies [a1a5c00]
- Updated dependencies [e70e7fd]
  - @statewalker/db-api@0.1.7
  - @statewalker/db-sqlite@0.1.3

## 0.2.3

### Patch Changes

- 9e4d9ca: Add a `default` export condition next to `import`, so CommonJS consumers can `require()` the ESM build (Node 20.19+, 22.12+).
- 0af2ed8: A failed engine load or OPFS pool install is no longer cached: a later open in the same worker tries again.
- 7f9f827: Every SQLite driver now handles input the same way. `query` rejects SQL with a second statement
  before running any of it (node ran only the first, the browser and the DO fake ran all of them),
  and `query` and `exec` reject empty SQL with `db-sqlite: the SQL is empty …`. Parameters are
  normalised: `true`/`false` bind as `1`/`0`, `undefined` as `NULL`, and a `Date` as its ISO 8601
  UTC text (an invalid Date rejects). An integer above 2^53 in a result comes back as an exact
  `bigint` on node and the DO fake too, as it already did in the browser; smaller ones stay numbers.
- bcc48c6: Stop publishing test files: `files` now excludes `src/**/*.test.ts` (and, in db-sqlite-index, `src/**/test-fixtures.ts`), and db-sqlite-index's Durable Object smoke scenarios moved out of `src/`. The published code is unchanged.
- Updated dependencies [9e4d9ca]
- Updated dependencies [1ca4b05]
- Updated dependencies [7f9f827]
- Updated dependencies [bcc48c6]
  - @statewalker/db-api@0.1.6
  - @statewalker/db-sqlite@0.1.2

## 0.2.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/db-api ^0.1.4 -> ^0.1.5
- Updated dependencies
  - @statewalker/db-sqlite@0.1.1

## 0.2.1

### Patch Changes

- 26d07e6: `newBrowserSqliteDb` takes `capacity`: the minimum number of files the OPFS pool holds. The default
  pool of 6 files holds about five databases; a full pool fails with `SQLITE_CANTOPEN`.

## 0.2.0

### Minor Changes

- 96eda11: Breaking: the engine is now `@sqlite.org/sqlite-wasm` instead of `@libsql/libsql-wasm-experimental`. A `path` opens an OPFS database through `opfs-sahpool` and is accepted only in a Dedicated Worker; `wasmUrl` now defaults to the package's own `sqlite3.wasm`; libSQL vector functions are gone; the Db supports `inTransaction` from `@statewalker/db-sqlite`.

### Patch Changes

- Updated dependencies
- Updated dependencies [4f7f4c9]
  - @statewalker/db-api@0.1.4
  - @statewalker/db-sqlite@0.1.0

## 0.1.4

### Patch Changes

- 33a8831: `newBrowserSqliteDb` honors `wasmUrl` on every call: the engine is cached per URL instead of once per page.

## 0.1.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/db-api@0.1.3

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/db-api@0.1.1
