---
"@statewalker/db-sqlite": patch
"@statewalker/db-sqlite-node": patch
"@statewalker/db-sqlite-browser": patch
"@statewalker/db-sqlite-do": patch
---

Every SQLite driver now handles input the same way. `query` rejects SQL with a second statement
before running any of it (node ran only the first, the browser and the DO fake ran all of them),
and `query` and `exec` reject empty SQL with `db-sqlite: the SQL is empty …`. Parameters are
normalised: `true`/`false` bind as `1`/`0`, `undefined` as `NULL`, and a `Date` as its ISO 8601
UTC text (an invalid Date rejects). An integer above 2^53 in a result comes back as an exact
`bigint` on node and the DO fake too, as it already did in the browser; smaller ones stay numbers.
