---
"@statewalker/db-duckdb-node": patch
---

`query` now binds `Uint8Array` as BLOB, `Date` as TIMESTAMP and arrays (and non-byte typed arrays) as LIST, inferring the item type from all items; before, these failed with "Cannot create values of type ANY". `query` also destroys its prepared statements and rejects SQL holding several statements instead of silently returning the first one's rows.
