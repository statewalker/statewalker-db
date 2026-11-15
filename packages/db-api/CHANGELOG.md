# @statewalker/db-api

## 0.1.6

### Patch Changes

- 9e4d9ca: Add a `default` export condition next to `import`, so CommonJS consumers can `require()` the ESM build (Node 20.19+, 22.12+).
- bcc48c6: Stop publishing test files: `files` now excludes `src/**/*.test.ts` (and, in db-sqlite-index, `src/**/test-fixtures.ts`), and db-sqlite-index's Durable Object smoke scenarios moved out of `src/`. The published code is unchanged.

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: dist/index.d.mts, src/db.ts

## 0.1.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md

## 0.1.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
