# @statewalker/db-tests

Shared behavioral **conformance** suite for `@statewalker/db-api` implementations.
Every `Db` adapter is verified against one spec instead of a copy-pasted per-adapter
suite.

## `runDbConformance(makeDb, options)`

```ts
import { runDbConformance } from "@statewalker/db-tests";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

runDbConformance(() => newNodeSqliteDb(), { placeholder: "?" });        // sqlite
runDbConformance(() => newNodeDuckDb(),   { placeholder: "$1" });       // duckdb
```

- **`makeDb: (options?: DbOptions) => Promise<Db>`** — async factory returning a fresh
  `Db`. `{ path }` selects a file backend (used by the persistence scenario).
- **`options.placeholder`** — the dialect positional placeholder (`?` for sqlite/libSQL,
  `$1` for duckdb). One suite serves both dialects by parameterizing this.
- **`options.normalizeRow?`** — projects each returned row to its expected columns before
  comparison, so the suite matches both duckdb (plain `{col: value}`) and libSQL (rows
  that also carry non-enumerable positional keys + `length`). Adapters pass
  `(row) => ({ ...row })`.

## What it covers (10 scenarios / 8 requirements)

`exec` non-returning + visibility · parameter binding + injection-safety · empty-result
array · multi-row · optional `flush` (skipped when the adapter lacks it) · post-`close`
rejection · file persistence across reopen (**node-only**) · invalid-SQL rejection.

## Scope

**Node-only.** The suite wires the node adapters (`db-sqlite-node`, `db-duckdb-node`).
Browser adapters (`db-sqlite-browser`, `db-duckdb-browser`) stay `describe.skip` under
node — they need a real browser test runner (Worker/WASM/OPFS), a deferred follow-up.

Each adapter keeps its own **dialect-specific** suites (FTS5 + vector search) alongside
the shared conformance suite — those exercise engine-specific SQL the shared contract
does not (sqlite: `libsql_vector_idx`/`vector32`; duckdb: HNSW/`array_distance`).
