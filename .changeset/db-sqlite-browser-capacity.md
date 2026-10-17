---
"@statewalker/db-sqlite-browser": patch
---

`newBrowserSqliteDb` takes `capacity`: the minimum number of files the OPFS pool holds. The default
pool of 6 files holds about five databases; a full pool fails with `SQLITE_CANTOPEN`.
