# statewalker-db

Database adapters: DuckDB and SQLite (libSQL) for browser and Node.

## Packages

<!-- List every package under `packages/` here with a one-line description and a link. Kept in sync by `scripts/new-monorepo.ts` and audited by `scripts/validate-migration.ts`. -->

| Package | Description |
| --- | --- |
| [@statewalker/db-api](packages/db-api) | Driver-agnostic database client interface. |
| [@statewalker/db-duckdb-browser](packages/db-duckdb-browser) | DuckDB WASM driver for browser environments. |
| [@statewalker/db-duckdb-node](packages/db-duckdb-node) | DuckDB Node.js driver backed by `@duckdb/node-api`. |
| [@statewalker/db-sqlite-browser](packages/db-sqlite-browser) | libSQL/SQLite WASM driver for browser environments. |
| [@statewalker/db-sqlite-node](packages/db-sqlite-node) | libSQL/SQLite Node.js driver backed by `@libsql/client`. |
| [@statewalker/db-tests](packages/db-tests) | Shared conformance suite every `db-api` implementation runs, in Node and (via Vitest browser mode) the browser. |

## Apps

| App | Description |
| --- | --- |
| [sqlite-search-demo](apps/sqlite-search-demo) | Vite demo combining FTS5 + vector search on real SQLite (`@sqlite.org/sqlite-wasm`, in-browser). |

## Cross-repo dependencies

**This repository depends on no other repository.** It is a foundation of the
StateWalker dependency graph — everything below it may be built without it.

**Depended on by:** [`statewalker-indexer`](https://github.com/statewalker/statewalker-indexer) (`@statewalker/db-api`).

Cross-repo dependencies are declared `workspace:*` rather than `catalog:`. This is
deliberate: turbo derives its task graph from `workspace:` specifiers and does **not**
resolve `catalog:`, so a `catalog:` cross-repo dependency is invisible to the scheduler
and its consumer can be built before it.

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

`pnpm run test` runs the Node test suites. The two browser adapters
(`db-sqlite-browser`, `db-duckdb-browser`) additionally run the shared
conformance suite in a **real headless Chromium** via Vitest browser mode +
Playwright:

```sh
pnpm exec playwright install chromium   # one-time: fetch the Chromium binary
pnpm run test:browser                    # run both browser adapter suites
```

`pnpm run test:browser` fans out to each browser package's own `test:browser`
script (`vitest run --config vitest.browser.config.ts`). To run just one:

```sh
pnpm --filter @statewalker/db-sqlite-browser test:browser
pnpm --filter @statewalker/db-duckdb-browser test:browser
```

The DuckDB browser suite fetches its WASM bundle from jsDelivr, so it needs
outbound network access from the browser; the libSQL suite serves `sqlite3.wasm`
locally (via the config's `publicDir`) and needs none.

## Release

Releases are managed via [changesets](https://github.com/changesets/changesets):

```sh
pnpm changeset           # describe the change
pnpm version-packages    # roll versions + regenerate CHANGELOGs
pnpm release-packages    # publish to npm
```
