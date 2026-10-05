# @statewalker/db-tests

Private package, not published. A shared conformance suite for
[`@statewalker/db-api`](../db-api) implementations. Every `Db` adapter in this
repository runs the same behavioral spec instead of its own copy.

`vitest` is a peer dependency. The package exports its TypeScript source
directly (`"." -> ./src/index.ts`).

## `runDbConformance(makeDb, options)`

```ts
import { runDbConformance } from "@statewalker/db-tests";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { newNodeDuckDb } from "@statewalker/db-duckdb-node";

runDbConformance(newNodeSqliteDb, {
  placeholder: "?",
  normalizeRow: (row) => ({ ...row }),
});
runDbConformance(newNodeDuckDb, {
  placeholder: "$1",
  normalizeRow: (row) => ({ ...row }),
});
```

- `makeDb: MakeDb`, that is `(options?: DbOptions) => Promise<Db>`: returns a
  fresh `Db`. The persistence scenario passes `{ path }` to get a file backend.
- `options.placeholder`: the positional placeholder of the dialect (`?` for
  SQLite/libSQL, `$1` for DuckDB).
- `options.normalizeRow?`: maps each row before comparison. libSQL rows carry
  non-enumerable positional keys and `length`; `(row) => ({ ...row })` keeps
  only the named columns.
- `options.skipFilePersistence?`: skip the file-persistence scenario, which
  uses `node:fs`. Browser adapters set it to `true`.

Exported types: `MakeDb`, `RunDbConformanceOptions`.

## What it covers (10 scenarios)

The factory result has the `Db` shape; `exec` writes are visible to later
queries; parameter binding; a SQL-metacharacter parameter is treated as a
literal; empty result; multi-row result; optional `flush` (skipped when the
adapter has none); `query` and `exec` reject after `close`; file persistence
across reopen (Node only); invalid SQL rejects.

## Where it runs

- Node adapters (`db-sqlite-node`, `db-duckdb-node`) run it in their regular
  `test` script.
- Browser adapters (`db-sqlite-browser`, `db-duckdb-browser`) run it in headless
  Chromium through their `test:browser` script, with
  `skipFilePersistence: true`.

Each adapter also has its own engine-specific tests (FTS and vector search)
next to the shared suite: libSQL `libsql_vector_idx` / `vector32`, DuckDB
`fts` and `vss` (HNSW, `array_distance`).
