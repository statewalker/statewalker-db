---
"@statewalker/db-api": patch
"@statewalker/db-duckdb-browser": patch
"@statewalker/db-duckdb-node": patch
"@statewalker/db-pglite": patch
"@statewalker/db-sqlite-browser": patch
"@statewalker/db-sqlite-do": patch
"@statewalker/db-sqlite-index": patch
"@statewalker/db-sqlite-node": patch
"@statewalker/db-sqlite": patch
---

Add a `default` export condition next to `import`, so CommonJS consumers can `require()` the ESM build (Node 20.19+, 22.12+).
