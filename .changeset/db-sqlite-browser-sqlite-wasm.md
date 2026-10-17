---
"@statewalker/db-sqlite-browser": minor
---

Breaking: the engine is now `@sqlite.org/sqlite-wasm` instead of `@libsql/libsql-wasm-experimental`. A `path` opens an OPFS database through `opfs-sahpool` and is accepted only in a Dedicated Worker; `wasmUrl` now defaults to the package's own `sqlite3.wasm`; libSQL vector functions are gone; the Db supports `inTransaction` from `@statewalker/db-sqlite`.
