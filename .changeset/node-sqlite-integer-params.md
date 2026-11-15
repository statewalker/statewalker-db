---
"@statewalker/db-sqlite-node": patch
"@statewalker/db-sqlite-do": patch
---

Integer-valued number parameters bind as INTEGER on node:sqlite (db-sqlite-node, and the fake DO storage), as on the browser driver; before, `5` was bound as REAL and stored as `5.0` in a TEXT column.
