# @statewalker/db-tests

## What it is

A private package (not published) with one Vitest suite,
`runDbConformance`, that checks a `Db` implementation from
`@statewalker/db-api` against the shared contract. Every driver in this
workspace runs it: the Node.js drivers in their `test` script, the browser
drivers in headless Chromium through `test:browser`.

## Why it exists

All drivers must behave the same through `Db`: the same results, the same
rejections, the same handling of parameters. One suite run against all four
keeps that true, instead of four copies of the same tests drifting apart.

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

Exported: `runDbConformance`, types `MakeDb`, `RunDbConformanceOptions`.

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

The suite has 10 scenarios:

1. The factory returns an object with the `Db` methods.
2. A row written with `exec` is visible to a later `query`.
3. A positional parameter binds and returns the matching row.
4. A parameter containing SQL metacharacters is treated as a literal.
5. A query with no match returns an empty array.
6. A query returns every matching row.
7. `flush`, when present, keeps earlier writes visible (skipped when absent).
8. `query` and `exec` reject after `close`.
9. Data written to a file survives close and reopen (Node.js only).
10. Invalid SQL rejects.

- **Why `normalizeRow`.** libSQL rows carry non-enumerable positional keys and
  `length`, so `toEqual` against a plain object fails. `(row) => ({ ...row })`
  keeps only the named columns and works for every driver.
- **Why the Node.js built-ins are imported through a variable.** The
  file-persistence scenario loads `node:fs/promises`, `node:os` and `node:path`
  with `import(specifier)` from a string variable, typed by a local shim. Vite
  cannot analyze a variable specifier, so a browser bundle never resolves them,
  and a browser typecheck needs no `@types/node`.
- **Engine-specific tests stay with each driver.** FTS and vector search use
  different SQL per engine (libSQL `fts5`, `libsql_vector_idx`; DuckDB `fts`
  and `vss` extensions), so they are not part of this suite.
- **Dependencies:** `@statewalker/db-api` (the `Db` type); peer `vitest`.

## License

MIT
