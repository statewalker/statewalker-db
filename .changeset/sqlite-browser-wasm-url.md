---
"@statewalker/db-sqlite-browser": patch
---

`newBrowserSqliteDb` honors `wasmUrl` on every call: the engine is cached per URL instead of once per page.
