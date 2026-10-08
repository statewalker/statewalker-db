# @statewalker/db-duckdb-browser

## 0.1.4

### Patch Changes

- 33a8831: `newBrowserDuckDb` now rejects when `options.path` cannot be opened (or OPFS is unavailable) instead of silently continuing in memory, and closes the prepared statement of every parameterised query.

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
