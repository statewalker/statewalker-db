---
"@statewalker/db-sqlite-index": patch
---

Keep vector recall after `compact()` on less-separated data: a flat segment (one list, below 2048 vectors) skips the 1-bit filter and is re-ranked whole with its int8 codes, raising recall@10 on 1500 vectors in 3 clusters from about 0.5 to 0.94-0.98. The segment format is unchanged.
