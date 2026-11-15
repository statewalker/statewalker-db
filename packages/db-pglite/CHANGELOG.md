# @statewalker/db-pglite

## 0.3.0

### Minor Changes

- a1a5c00: The `Db` keeps the shared lifecycle contract (`newSerialisedDb` from `@statewalker/db-sqlite`): calls run one at a time in call order; `close()` waits for in-flight calls, then closes PGlite; calls made after `close()` has started reject with `db-pglite: the database is closed`; closing twice is a no-op. Integers within ±(2^53 - 1) come back as `number`, larger ones as `bigint`.

### Patch Changes

- Updated dependencies [a1a5c00]
- Updated dependencies [a1a5c00]
- Updated dependencies [e70e7fd]
  - @statewalker/db-api@0.1.7
  - @statewalker/db-sqlite@0.1.3

## 0.2.0

### Minor Changes

- c0c89a0: `@electric-sql/pglite` is now a peer dependency (`^0.5.15`) instead of a regular dependency, so
  the driver and the extensions you pass (such as `@electric-sql/pglite-pgvector`) share one PGlite
  instead of installing two copies. Breaking for consumers (a minor bump on this 0.x line): install
  `@electric-sql/pglite` yourself, at the version your extensions are built for.

### Patch Changes

- 9e4d9ca: Add a `default` export condition next to `import`, so CommonJS consumers can `require()` the ESM build (Node 20.19+, 22.12+).
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

- c14e875: New package: `newPgliteDb({ path?, extensions? })`, a Db on PGlite with caller-supplied extensions.

### Patch Changes

- Updated dependencies
  - @statewalker/db-api@0.1.4
