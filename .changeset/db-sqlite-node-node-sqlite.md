---
"@statewalker/db-sqlite-node": minor
---

Breaking: the engine is now Node.js's built-in `node:sqlite` instead of `@libsql/client`. libSQL vector functions (`vector32`, `libsql_vector_idx`, `vector_top_k`) are gone; rows are plain objects; the Db supports `inTransaction` from `@statewalker/db-sqlite`.
