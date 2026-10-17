---
"@statewalker/db-sqlite-index": minor
---

Add `./ngram`: `NgramStore`, an id-based trigram index over SQLite (`fts5` or `postings` store) that answers literal and regex searches exactly, plus the pure `planQuery`, `trigrams` and `fold` helpers.
