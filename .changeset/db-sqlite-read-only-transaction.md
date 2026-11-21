---
"@statewalker/db-sqlite": patch
---

Adds `inReadOnlyTransaction(db, cb)`: runs `cb` in a transaction that is always rolled back, on Node.js, in the browser and on a Durable Object, returning `cb`'s value or rethrowing its error; nothing written inside persists. Statements that would end the transaction or reach outside it (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE, ATTACH, DETACH, PRAGMA, VACUUM, or a statement not starting with a keyword) are refused, and once a statement fails the handle refuses later calls, since SQLite can end a transaction itself (`INSERT OR ROLLBACK`). Also adds `hasReadOnlyTransaction(db)` and the hook's key `SQLITE_READ_ONLY_TRANSACTION`.
