---
"@statewalker/db-sqlite": patch
---

`query` passes only the statement itself to the engine, without its ending semicolon and empty tail: Durable Object SQLite rejected `SELECT 1; -- comment` with "SQL code did not contain a statement".
