---
"@statewalker/db-duckdb-browser": patch
---

Return plain JS values like `@statewalker/db-duckdb-node`: DECIMAL as a scaled number, DATE and TIMESTAMP as `Date`, LIST as an array, STRUCT as a plain object, MAP as `{ key, value }` entries. Bind `bigint` and `Date` parameters (as exact strings) instead of throwing or binding the wrong type, and reject unsupported parameter types (binary data, arrays, objects, non-finite numbers) with an error naming the type.
