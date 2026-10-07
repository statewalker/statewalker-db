---
"@statewalker/db-duckdb-browser": patch
---

`newBrowserDuckDb` now rejects when `options.path` cannot be opened (or OPFS is unavailable) instead of silently continuing in memory, and closes the prepared statement of every parameterised query.
