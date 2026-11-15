---
"@statewalker/db-sqlite-index": patch
---

ngram planner no longer misses matches for escaped character-class ranges (`[\.-z]`), octal class escapes, or lone surrogates in regex literals.
