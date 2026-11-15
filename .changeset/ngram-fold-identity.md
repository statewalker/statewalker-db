---
"@statewalker/db-sqlite-index": patch
---

`NgramStore.init()` records the runtime's case-fold identity in `{p}meta` and, when an index
was written by a runtime whose case mappings differ, rebuilds its grams from the stored texts
before any write, so a later delete cannot corrupt a contentless FTS5 index or leave stale
postings. Indexes without a recorded identity get one on first open, without a rebuild;
older versions ignore the new meta key.
