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

## Apps

| App | Description |
| --- | --- |
| [turso-search-demo](apps/turso-search-demo) | Vite demo combining FTS5 + vector search on `db-sqlite-browser`. |

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

## Release

Releases are managed via [changesets](https://github.com/changesets/changesets):

```sh
pnpm changeset           # describe the change
pnpm version-packages    # roll versions + regenerate CHANGELOGs
pnpm release-packages    # publish to npm
```
