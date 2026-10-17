---
"@statewalker/db-sqlite-index": minor
---

New package. `./vector`: an IVF vector index (1-bit residual filter, int8 re-rank, float32 re-rank) whose tail and segments are SQLite rows behind `Db`, so it runs on node:sqlite, sqlite-wasm and Durable Objects. Writes go through `inTransaction`; BLOBs stay under 1 MiB per row; the tail auto-compacts at 4096 vectors.
