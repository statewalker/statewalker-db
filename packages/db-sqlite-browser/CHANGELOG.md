# @statewalker/db-sqlite-browser

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
