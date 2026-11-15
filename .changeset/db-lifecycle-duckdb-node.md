---
"@statewalker/db-duckdb-node": minor
---

The `Db` keeps the shared lifecycle contract (`newSerialisedDb` from `@statewalker/db-sqlite`): calls run one at a time in call order; `close()` waits for in-flight calls, then closes (closing during a query used to fail it with `bad_weak_ptr` or crash the process); calls made after `close()` has started reject with `db-duckdb-node: the database is closed` (was `Failed to query: connection disconnected`); closing twice is a no-op. Breaking: integers within ±(2^53 - 1) now come back as `number`, larger ones as `bigint`, for every column type (`BIGINT`, `UBIGINT`, `HUGEINT`, `count(*)`, `TIME`), also inside lists and structs; they used to be `bigint` whatever their size.
