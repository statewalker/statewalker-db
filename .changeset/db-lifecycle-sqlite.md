---
"@statewalker/db-sqlite": patch
---

Adds `newSerialisedDb(engine, { name })` and the `SerialisedDbEngine` type: the engine-neutral lifecycle wrapper (one call at a time in call order, `close()` waits for earlier calls, later calls reject with `<name>: the database is closed`, closing twice is a no-op, safe integers as numbers) that the DuckDB and PGlite drivers now share with `newSerialisedSqliteDb`. SQLite Dbs now reject a call made after `close()` has started at once instead of after the queue drains (same error).
