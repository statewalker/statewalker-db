---
"@statewalker/db-api": patch
---

The `Db` JSDoc states the contract every driver keeps: call order, `close()` waiting for in-flight calls, `<driver>: the database is closed` for later calls, idempotent `close()`, and the value types of BLOBs, integers, decimals and dates (per engine where the engines differ).
