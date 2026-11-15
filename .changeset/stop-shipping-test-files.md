---
"@statewalker/db-api": patch
"@statewalker/db-duckdb-browser": patch
"@statewalker/db-duckdb-node": patch
"@statewalker/db-pglite": patch
"@statewalker/db-sqlite": patch
"@statewalker/db-sqlite-browser": patch
"@statewalker/db-sqlite-do": patch
"@statewalker/db-sqlite-index": patch
"@statewalker/db-sqlite-node": patch
---

Stop publishing test files: `files` now excludes `src/**/*.test.ts` (and, in db-sqlite-index, `src/**/test-fixtures.ts`), and db-sqlite-index's Durable Object smoke scenarios moved out of `src/`. The published code is unchanged.
