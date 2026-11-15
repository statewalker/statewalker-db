---
"@statewalker/db-sqlite-index": patch
---

Internal refactor of `VectorIndex`: one module (`GenerationCatalog`) now owns the generation catalog (the committed state, the ids and tail tables and their in-memory copy) and is the only place that commits a state change, so the copy and storage cannot drift apart. No change to behaviour, stored format or public API.
