---
"@statewalker/db-sqlite-index": patch
---

Vector search: deleted or overwritten segment rows no longer take the candidate slots of live vectors, so `search` returns `k` results after heavy deletes (#33). `search` rejects at once on an already-aborted signal, and `upsert`/`search` reject a zero vector under the cosine metric (#42).
