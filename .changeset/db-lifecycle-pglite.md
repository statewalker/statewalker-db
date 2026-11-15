---
"@statewalker/db-pglite": minor
---

The `Db` keeps the shared lifecycle contract (`newSerialisedDb` from `@statewalker/db-sqlite`): calls run one at a time in call order; `close()` waits for in-flight calls, then closes PGlite; calls made after `close()` has started reject with `db-pglite: the database is closed`; closing twice is a no-op. Integers within ±(2^53 - 1) come back as `number`, larger ones as `bigint`.
