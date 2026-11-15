---
"@statewalker/db-sqlite": patch
---

Reject a parameter SQLite cannot bind (a plain object, `Map`, array, function, symbol or boxed primitive) with a `TypeError` naming its 1-based index and type, before anything runs, on the Db and on the transaction handle. db-sqlite-node and db-sqlite-do used to drop a leading object and bind the other parameters one column to the left. An `ArrayBuffer` and every ArrayBuffer view (`DataView`, `Float32Array`, …) now bind as a BLOB of exactly their bytes on every SQLite driver.
