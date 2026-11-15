---
"@statewalker/db-duckdb-browser": minor
---

The `Db` keeps the shared lifecycle contract (`newSerialisedDb` from `@statewalker/db-sqlite`): calls (`flush` included) run one at a time in call order; `close()` waits for in-flight calls, then terminates the worker (a query pending at `close()` used to never settle); calls made after `close()` has started reject with `db-duckdb-browser: the database is closed`; closing twice is a no-op. Breaking: integers within ±(2^53 - 1) now come back as `number`, larger ones as `bigint`, for every column type (`BIGINT`, `UBIGINT`, `HUGEINT`, `TIME`, `count(*)`), also inside lists, structs and maps; they used to be `bigint` whatever their size.
