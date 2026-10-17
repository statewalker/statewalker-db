# @statewalker/db-sqlite-node

## 0.3.0

### Minor Changes

- 8e3e346: Breaking: the engine is now Node.js's built-in `node:sqlite` instead of `@libsql/client`. libSQL vector functions (`vector32`, `libsql_vector_idx`, `vector_top_k`) are gone; rows are plain objects; the Db supports `inTransaction` from `@statewalker/db-sqlite`.

### Patch Changes

- Updated dependencies
- Updated dependencies [4f7f4c9]
  - @statewalker/db-api@0.1.4
  - @statewalker/db-sqlite@0.1.0

## 0.2.1

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
