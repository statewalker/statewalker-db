# @statewalker/db-sqlite-index

## 0.1.3

### Patch Changes

- 93cfbac: Internal refactor of `VectorIndex`: one module (`GenerationCatalog`) now owns the generation catalog (the committed state, the ids and tail tables and their in-memory copy) and is the only place that commits a state change, so the copy and storage cannot drift apart. No change to behaviour, stored format or public API.
- 776cb39: `VectorIndex.refresh()` no longer races `compact()`, `merge()` or `upsert()`. It waits for a running compact or merge, runs between writes, and swaps the segment list under the read epoch. Before, a refresh overlapping a compact installed the state from before the commit with the tail from after it: the compacted vectors vanished from search, the next compact failed on a reused generation, and the next write persisted the stale state, so a reopened index deleted the compacted segment for good (#26).
- Updated dependencies [a1a5c00]
- Updated dependencies [a1a5c00]
- Updated dependencies [e70e7fd]
  - @statewalker/db-api@0.1.7
  - @statewalker/db-sqlite@0.1.3

## 0.1.2

### Patch Changes

- d5f1a0a: `NgramStore.init()` records the runtime's case-fold identity in `{p}meta` and, when an index
  was written by a runtime whose case mappings differ, rebuilds its grams from the stored texts
  before any write, so a later delete cannot corrupt a contentless FTS5 index or leave stale
  postings. Indexes without a recorded identity get one on first open, without a rebuild;
  older versions ignore the new meta key.
- c110085: ngram planner no longer misses matches for escaped character-class ranges (`[\.-z]`), octal class escapes, or lone surrogates in regex literals.
- 9e4d9ca: Add a `default` export condition next to `import`, so CommonJS consumers can `require()` the ESM build (Node 20.19+, 22.12+).
- bcc48c6: Stop publishing test files: `files` now excludes `src/**/*.test.ts` (and, in db-sqlite-index, `src/**/test-fixtures.ts`), and db-sqlite-index's Durable Object smoke scenarios moved out of `src/`. The published code is unchanged.
- 23319f3: Vector search without an explicit `nprobe` now probes at least 8 lists per segment and keeps
  adding lists in centroid order until they hold `16 × k × oversample` rows. After auto-compaction
  a 4200-vector segment has about 65 small lists, and on data with few natural clusters recall@10
  at default settings was about 0.7; it is now about 0.94. An explicit `nprobe` still probes
  exactly that many lists. The stored segment format is unchanged.
- 35da93c: Keep vector recall after `compact()` on less-separated data: a flat segment (one list, below 2048 vectors) skips the 1-bit filter and is re-ranked whole with its int8 codes, raising recall@10 on 1500 vectors in 3 clusters from about 0.5 to 0.94-0.98. The segment format is unchanged.
- 48a9eeb: Vector search: deleted or overwritten segment rows no longer take the candidate slots of live vectors, so `search` returns `k` results after heavy deletes (#33). `search` rejects at once on an already-aborted signal, and `upsert`/`search` reject a zero vector under the cosine metric (#42).
- Updated dependencies [9e4d9ca]
- Updated dependencies [1ca4b05]
- Updated dependencies [7f9f827]
- Updated dependencies [bcc48c6]
  - @statewalker/db-api@0.1.6
  - @statewalker/db-sqlite@0.1.2

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
