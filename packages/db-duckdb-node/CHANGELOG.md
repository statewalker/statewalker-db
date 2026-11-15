# @statewalker/db-duckdb-node

## 0.1.6

### Patch Changes

- 7444ae8: `query` now binds `Uint8Array` as BLOB, `Date` as TIMESTAMP and arrays (and non-byte typed arrays) as LIST, inferring the item type from all items; before, these failed with "Cannot create values of type ANY". `query` also destroys its prepared statements and rejects SQL holding several statements instead of silently returning the first one's rows.
- 9e4d9ca: Add a `default` export condition next to `import`, so CommonJS consumers can `require()` the ESM build (Node 20.19+, 22.12+).
- bcc48c6: Stop publishing test files: `files` now excludes `src/**/*.test.ts` (and, in db-sqlite-index, `src/**/test-fixtures.ts`), and db-sqlite-index's Durable Object smoke scenarios moved out of `src/`. The published code is unchanged.
- Updated dependencies [9e4d9ca]
- Updated dependencies [bcc48c6]
  - @statewalker/db-api@0.1.6

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/db-api ^0.1.4 -> ^0.1.5

## 0.1.4

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/db-api ^0.1.3 -> ^0.1.4

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
