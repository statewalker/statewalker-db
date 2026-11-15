# @statewalker/db-sqlite-index

## 0.1.1

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: dist/ngram.d.mts.map, dist/ngram.mjs, dist/ngram.mjs.map, dist/prefix-CTeW1EwH.mjs, dist/prefix-CTeW1EwH.mjs.map, 7 more
- Updated dependencies
  - @statewalker/db-api@0.1.5

## 0.1.0

### Minor Changes

- 82bbb43: Add `./ngram`: `NgramStore`, an id-based trigram index over SQLite (`fts5` or `postings` store) that answers literal and regex searches exactly, plus the pure `planQuery`, `trigrams` and `fold` helpers.
- a21832e: New package. `./vector`: an IVF vector index (1-bit residual filter, int8 re-rank, float32 re-rank) whose tail and segments are SQLite rows behind `Db`, so it runs on node:sqlite, sqlite-wasm and Durable Objects. Writes go through `inTransaction`; BLOBs stay under 1 MiB per row; the tail auto-compacts at 4096 vectors.

### Patch Changes

- Updated dependencies
- Updated dependencies [4f7f4c9]
  - @statewalker/db-api@0.1.4
  - @statewalker/db-sqlite@0.1.0
