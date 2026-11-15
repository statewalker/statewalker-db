# @statewalker/db-duckdb-browser

## 0.2.0

### Minor Changes

- a1a5c00: The `Db` keeps the shared lifecycle contract (`newSerialisedDb` from `@statewalker/db-sqlite`): calls (`flush` included) run one at a time in call order; `close()` waits for in-flight calls, then terminates the worker (a query pending at `close()` used to never settle); calls made after `close()` has started reject with `db-duckdb-browser: the database is closed`; closing twice is a no-op. Breaking: integers within ±(2^53 - 1) now come back as `number`, larger ones as `bigint`, for every column type (`BIGINT`, `UBIGINT`, `HUGEINT`, `TIME`, `count(*)`), also inside lists, structs and maps; they used to be `bigint` whatever their size.

### Patch Changes

- Updated dependencies [a1a5c00]
- Updated dependencies [a1a5c00]
- Updated dependencies [e70e7fd]
  - @statewalker/db-api@0.1.7
  - @statewalker/db-sqlite@0.1.3

## 0.1.8

### Patch Changes

- 3dfc464: OPFS databases persist again: pin `@duckdb/duckdb-wasm` to exactly `1.33.1-dev65.0` (was `^1.33.1-dev57.0`). With 1.33.1-dev57.0 a new `opfs://` database was never written to OPFS and was empty after a reopen (#74); 1.33.1-dev60.0 and later fix it. The pin is exact because npm compares `devN` prerelease tags as text, so a caret range would not select the intended build. The bundle shape (`mvp`/`eh`) is unchanged.

## 0.1.7

### Patch Changes

- 7ff1437: A failed start no longer leaks its Web Worker: if instantiating the engine, opening the path or connecting rejects, the engine and worker are terminated and the jsDelivr Blob URL is revoked before the original error is rethrown. `path` without self-hosted `bundles` now rejects up front with `Cannot open DuckDB database "<path>": OPFS needs self-hosted \`bundles\``, instead of starting the cross-origin jsDelivr worker that crashes on OPFS file I/O.
- cf23e06: README: OPFS persistence does not work with duckdb-wasm 1.33.1-dev57.0 (#74).
- 2e0cd99: Return plain JS values like `@statewalker/db-duckdb-node`: DECIMAL as a scaled number, DATE and TIMESTAMP as `Date`, LIST as an array, STRUCT as a plain object, MAP as `{ key, value }` entries. Bind `bigint` and `Date` parameters (as exact strings) instead of throwing or binding the wrong type, and reject unsupported parameter types (binary data, arrays, objects, non-finite numbers) with an error naming the type.
- 9e4d9ca: Add a `default` export condition next to `import`, so CommonJS consumers can `require()` the ESM build (Node 20.19+, 22.12+).
- bcc48c6: Stop publishing test files: `files` now excludes `src/**/*.test.ts` (and, in db-sqlite-index, `src/**/test-fixtures.ts`), and db-sqlite-index's Durable Object smoke scenarios moved out of `src/`. The published code is unchanged.
- Updated dependencies [9e4d9ca]
- Updated dependencies [bcc48c6]
  - @statewalker/db-api@0.1.6

## 0.1.6

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/db-api ^0.1.4 -> ^0.1.5

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/db-api ^0.1.3 -> ^0.1.4

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
