# @statewalker/db-tests

## What it is

A private package (not published) with two Vitest suites,
`runDbConformance` and `runSqliteTransactionConformance`, that checks a `Db` implementation from
`@statewalker/db-api` against the shared contract. Every driver in this
workspace runs `runDbConformance`, and the three SQLite drivers also run
`runSqliteTransactionConformance`: the Node.js drivers (and `db-sqlite-browser`, in memory) in
their `test` script, the browser drivers in headless Chromium through `test:browser`, and
`db-sqlite-do` both on its Node.js fake in `test` and inside a real Durable Object through
`test:do`.

## Why it exists

All drivers must behave the same through `Db`: the same results, the same
rejections, the same handling of parameters. One suite run against every
driver keeps that true, instead of one copy of the same tests per driver drifting apart.

## How to use

Add it as a workspace dev dependency of a driver package. `vitest` is a peer
dependency. The package exports its TypeScript source directly
(`"." -> ./src/index.ts`).

`runDbConformance(makeDb, options)` registers a `describe("Db conformance")`
block.

- `makeDb: MakeDb`, i.e. `(options?: DbOptions) => Promise<Db>`: returns a
  fresh `Db`. The file-persistence scenario passes `{ path }`.
- `options.placeholder`: the positional placeholder the suite writes into its
  SQL, for example `?` or `$1`.
- `options.normalizeRow?`: maps each row before comparing it. Default: none.
- `options.skipFilePersistence?`: skip the scenario that writes to a temp
  directory with `node:fs`. Browser drivers set it to `true`.
- `options.blobType?`: the column type the BLOB round trip declares. Default
  `BLOB`; `db-pglite` passes `BYTEA`.
- `options.skip?`: scenario names (the `it` titles) a platform cannot meet,
  skipped instead of run; give the reason next to the list. `db-duckdb-browser`
  skips the BLOB parameter round trip (duckdb-wasm cannot bind binary data);
  the real-DO run of `db-sqlite-do` skips the scenarios its HTTP/JSON harness
  cannot carry (`test-do/unsupported-scenarios.ts`).

Exported from `@statewalker/db-tests`: `runDbConformance`, `runSqliteTransactionConformance`,
`sqliteTransactionScenarios`; types `MakeDb`, `RunDbConformanceOptions`,
`SqliteTransactionScenario` (`{ name, run(db) }`).

`@statewalker/db-tests/celld-dev` exports `celldDevSetup(dir)`, a Vitest global setup for a
package's real-Durable-Object suite (`test:do`): it starts `celld dev` on `dir` (a directory with
a `wrangler.jsonc`) with a clean state on a free port, provides its URL as
`inject("doBaseUrl")`, and stops that process afterwards. It needs celld 0.6.x on `PATH`. It is a
separate subpath because it imports Node.js built-ins.

`runSqliteTransactionConformance(makeDb)` registers a `describe("SQLite transaction
conformance")` block for SQLite drivers (`makeDb: () => Promise<Db>`, a fresh empty Db each
time). Its scenarios are plain async functions with no Vitest import, exported as
`sqliteTransactionScenarios` and from the subpath
`@statewalker/db-tests/sqlite-transaction-scenarios`, so a Durable Object worker can bundle
and run the very same checks against real DO SQLite. `{ skip: [name, …] }` drops the
scenarios a platform cannot meet, by name. Besides transactions (commit, rollback, a failing
`COMMIT`, queueing, nesting, handle expiry, and read-only transactions that always roll back and
refuse statements that would slip out), they pin what every SQLite driver must do the same
way: call order on a plain Db, an idempotent `close`, BLOBs, parameter types (boolean,
`undefined`, `Date`, `bigint`), integers above 2^53, the rejection of a second statement in
`query`, and the rejection of empty SQL.

## Examples

A Node.js driver test:

```ts
import { runDbConformance } from "@statewalker/db-tests";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

runDbConformance(newNodeSqliteDb, {
  placeholder: "?",
  normalizeRow: (row) => ({ ...row }),
});
```

A browser driver test (`*.browser.test.ts`, run by the Vitest browser config):

```ts
import { runDbConformance } from "@statewalker/db-tests";
import { newBrowserDuckDb } from "@statewalker/db-duckdb-browser";

runDbConformance(() => newBrowserDuckDb(), {
  placeholder: "$1",
  normalizeRow: (row) => ({ ...row }),
  skipFilePersistence: true,
});
```

## Internals

`runDbConformance` has 18 scenarios, which together state the `Db` contract
written in the JSDoc of `Db` (`@statewalker/db-api`):

1. The factory returns an object with the `Db` methods.
2. A row written with `exec` is visible to a later `query`.
3. A positional parameter binds and returns the matching row.
4. A parameter containing SQL metacharacters is treated as a literal.
5. A query with no match returns an empty array.
6. A query returns every matching row.
7. `flush`, when present, keeps earlier writes visible (skipped when absent).
8. `query`, `exec` and `flush` reject after `close` with `the database is closed`.
9. `close()` waits for an in-flight query (and one queued behind it), then closes.
10. Calls made once `close()` has started reject with `the database is closed`.
11. Closing twice, overlapping or one after the other, is a no-op.
12. Calls issued without awaiting each other run in call order.
13. A `Uint8Array` parameter comes back from a BLOB column as a `Uint8Array`.
14. Integers are numbers within ±(2^53 - 1) and bigints beyond (`BIGINT`, `count(*)`).
15. A `DECIMAL(10,2)` keeps its numeric value (a `number` or, on PGlite, a decimal string).
16. A `Date` parameter keeps its instant (a `Date`, or ISO text on SQLite).
17. Data written to a file survives close and reopen (Node.js only).
18. Invalid SQL rejects.

- **Why `normalizeRow`.** Some drivers return rows with a `null` prototype or
  extra non-enumerable keys; `(row) => ({ ...row })` keeps only the named columns.
- **Why the Node.js built-ins are imported through a variable.** The
  file-persistence scenario loads `node:fs/promises`, `node:os` and `node:path`
  with `import(specifier)` from a string variable, typed by a local shim. Vite
  cannot analyze a variable specifier, so a browser bundle never resolves them,
  and a browser typecheck needs no `@types/node`.
- **Engine-specific tests stay with each driver.** FTS and vector search use
  different SQL per engine (SQLite FTS5; DuckDB `fts` and `vss`), so they are not part of this suite.
- **The transaction scenarios are vitest-free on purpose.** They throw `scenario check failed: ...` on the first failed check. The `db-sqlite-do` `test:do` suite runs them inside a Durable Object, where Vitest cannot run.
- **Source only.** The package is private and its exports point at `src/`; there is no build.
- **Dependencies:** `@statewalker/db-api` (the `Db` type); `@statewalker/db-sqlite` (`inTransaction`, used by the transaction scenarios); peer `vitest`.

## License

MIT
