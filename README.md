# statewalker-db

Database adapters for StateWalker. One small interface, `Db` from
`@statewalker/db-api`, with four implementations: DuckDB and SQLite (libSQL),
each for the browser and for Node.js.

## Packages

| Package | Description | npm |
| --- | --- | --- |
| [@statewalker/db-api](packages/db-api) | The `Db` interface (`query`, `exec`, optional `flush`, `close`). Types only. | [npm](https://www.npmjs.com/package/@statewalker/db-api) |
| [@statewalker/db-duckdb-browser](packages/db-duckdb-browser) | DuckDB WASM driver for the browser (`@duckdb/duckdb-wasm`), optional OPFS persistence. | [npm](https://www.npmjs.com/package/@statewalker/db-duckdb-browser) |
| [@statewalker/db-duckdb-node](packages/db-duckdb-node) | DuckDB driver for Node.js (`@duckdb/node-api`). | [npm](https://www.npmjs.com/package/@statewalker/db-duckdb-node) |
| [@statewalker/db-sqlite-browser](packages/db-sqlite-browser) | libSQL/SQLite WASM driver for the browser (`@libsql/libsql-wasm-experimental`). | [npm](https://www.npmjs.com/package/@statewalker/db-sqlite-browser) |
| [@statewalker/db-sqlite-node](packages/db-sqlite-node) | libSQL/SQLite driver for Node.js (`@libsql/client`). | [npm](https://www.npmjs.com/package/@statewalker/db-sqlite-node) |
| [@statewalker/db-tests](packages/db-tests) | Shared conformance test suite run by every adapter. | private |

Apps and tools (private, not published):

| Folder | Description |
| --- | --- |
| [apps/sqlite-search-demo](apps/sqlite-search-demo) | Vite demo: FTS5 and vector search on SQLite (`@sqlite.org/sqlite-wasm`) in the browser. |
| [tools/consumer-install](tools/consumer-install) | Test that packs the public packages and installs them into a clean project. |

## Relation to other statewalker repositories

This repository depends on no other `@statewalker` repository. It sits at the
bottom of the dependency graph.

Known consumers:

- [statewalker-knowledge](https://github.com/statewalker/statewalker-knowledge)
  (`notebook-db`, `notebook-build`)
- [statewalker-search](https://github.com/statewalker/statewalker-search)
  (`indexer-duckdb`)

## Requirements

- Node.js 24
- pnpm 10, via corepack (`corepack enable`; the version is pinned in
  `packageManager` in `package.json`)

## Development

```sh
pnpm install
pnpm run build        # build all packages (tsdown)
pnpm run test         # Node test suites (vitest), including tools/consumer-install
pnpm run typecheck    # tsc --noEmit in every package
pnpm run lint         # biome check --write
pnpm run lint:check   # biome check, no writes
pnpm run format       # biome format --write
pnpm run format:check # biome format, no writes
```

`tools/consumer-install` packs every public package and runs `npm install` on
the tarballs, so `pnpm run test` takes minutes. To run one package's tests:
`pnpm --filter @statewalker/db-sqlite-node test`.

### Browser tests

The two browser adapters (`db-sqlite-browser`, `db-duckdb-browser`) also run
the shared conformance suite in headless Chromium (Vitest browser mode with
Playwright):

```sh
pnpm exec playwright install chromium   # once: download Chromium
pnpm run test:browser                    # both browser adapters
pnpm --filter @statewalker/db-sqlite-browser test:browser   # just one
```

The DuckDB browser suite loads its WASM bundle from jsDelivr, so the browser
needs network access. The libSQL suite serves `sqlite3.wasm` locally (Vite
`publicDir`) and needs none.

## Releases

Releases are automatic and use [changesets](https://github.com/changesets/changesets).
After CI passes on `main`, a job writes a changeset for every package whose
packed contents differ from the version on npm, and opens a
"chore: version packages" pull request. Merging that pull request publishes the
packages to npm with provenance.

To choose the version bump or the changelog text yourself, add a changeset in
your pull request:

```sh
pnpm changeset
```

Dependency updates come from Renovate. CI, release and Renovate setup are
shared across the statewalker repositories and documented in
[statewalker/.github](https://github.com/statewalker/.github#readme).

## License

[MIT](LICENSE)
