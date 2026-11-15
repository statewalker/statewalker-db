---
"@statewalker/db-sqlite-index": patch
---

`VectorIndex.refresh()` no longer races `compact()`, `merge()` or `upsert()`. It waits for a running compact or merge, runs between writes, and swaps the segment list under the read epoch. Before, a refresh overlapping a compact installed the state from before the commit with the tail from after it: the compacted vectors vanished from search, the next compact failed on a reused generation, and the next write persisted the stale state, so a reopened index deleted the compacted segment for good (#26).
