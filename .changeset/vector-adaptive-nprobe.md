---
"@statewalker/db-sqlite-index": patch
---

Vector search without an explicit `nprobe` now probes at least 8 lists per segment and keeps
adding lists in centroid order until they hold `16 × k × oversample` rows. After auto-compaction
a 4200-vector segment has about 65 small lists, and on data with few natural clusters recall@10
at default settings was about 0.7; it is now about 0.94. An explicit `nprobe` still probes
exactly that many lists. The stored segment format is unchanged.
