# statewalker-db

## What it is

A pnpm workspace with one database interface and its drivers. Code
written against the `Db` type from `@statewalker/db-api` runs on DuckDB, on SQLite
(Node.js, browser WASM or a Durable Object) or on PGlite, depending on which driver
creates the instance. A shared conformance suite checks that all drivers
behave the same. The workspace depends on no other `@statewalker` package.

## Layout: one interface, its drivers, one suite that checks them

```
 @statewalker/db-api   (types only: Db, DbEntry, DbOptions)
  |
  +-- db-duckdb-browser      @duckdb/duckdb-wasm
  +-- db-duckdb-node         @duckdb/node-api
  +-- db-pglite              @electric-sql/pglite
  +-- db-sqlite              inTransaction + the call queue of every SQLite driver
       +-- db-sqlite-browser   @sqlite.org/sqlite-wasm
       +-- db-sqlite-node      node:sqlite
       +-- db-sqlite-do        Durable Object ctx.storage
       +-- db-sqlite-index     vector and n-gram indexes; run on a Db of any of the three above

 @statewalker/db-tests (private): runDbConformance, run by every driver;
 runSqliteTransactionConformance, run by the three SQLite drivers
```

| Folder | Package | Published |
| --- | --- | --- |
| `packages/db-api` | `@statewalker/db-api`: the `Db` interface | npm |
| `packages/db-duckdb-browser` | `@statewalker/db-duckdb-browser`: DuckDB WASM in a Web Worker, optional OPFS persistence | npm |
| `packages/db-duckdb-node` | `@statewalker/db-duckdb-node`: DuckDB with native Node.js bindings | npm |
| `packages/db-sqlite-browser` | `@statewalker/db-sqlite-browser`: the official SQLite WASM build; in memory anywhere, OPFS in a Dedicated Worker | npm |
| `packages/db-sqlite-node` | `@statewalker/db-sqlite-node`: Node.js's built-in `node:sqlite` | npm |
| `packages/db-sqlite` | `@statewalker/db-sqlite`: `inTransaction` and the queue every SQLite driver uses | npm |
| `packages/db-pglite` | `@statewalker/db-pglite`: PGlite (Postgres in WASM), Node.js and browser | npm |
| `packages/db-sqlite-index` | `@statewalker/db-sqlite-index`: IVF vector index (`./vector`) and trigram text/regex index (`./ngram`) in SQLite tables | npm |
| `packages/db-sqlite-do` | `@statewalker/db-sqlite-do`: Durable Object SQLite, plus a Node.js fake | npm |
| `packages/db-tests` | `@statewalker/db-tests`: the shared conformance suite | private |
| `apps/sqlite-search-demo` | `@statewalker/sqlite-search-demo`: Vite demo of FTS5 and vector search on `@sqlite.org/sqlite-wasm` | private |
| `tools/consumer-install` | `@statewalker/consumer-install-tests`: packs the public packages and installs them like an npm consumer | private |

## How to run it

Requirements: Node.js 24 and pnpm 10. The pnpm version is pinned in
`packageManager` in `package.json`; `corepack enable` makes `pnpm` use it.

1. `pnpm install`
2. `pnpm run build` builds every package with tsdown into its `dist/` (and the
   demo with Vite).
3. `pnpm run test` runs the Node test suites, including
   `tools/consumer-install`.
4. Optional, the browser drivers in headless Chromium:
   1. `pnpm exec playwright install chromium` (once)
   2. `pnpm run test:browser`
5. Optional, the Durable Object driver on a real celld: `pnpm run test:do` (needs celld 0.6.x on PATH).
6. Before pushing: `pnpm run lint:check`, `pnpm run format:check`,
   `pnpm run typecheck`. CI runs these together with build and test.

## Why it is the way it is

- **The interface is four methods.** `query`, `exec`, `close` and an optional
  `flush` are what every engine here can do the same way. Engine-specific
  features (FTS, vector indexes) are plain SQL passed through `query` and
  `exec`.
- **Packages export `dist/`, not TypeScript.** Node.js refuses to strip types
  from files under `node_modules`, so a raw `./src/index.ts` entry fails for
  any consumer without a bundler. Each `exports` entry has `types` and `import`
  pointing at `dist/`, plus a `source` condition pointing at `src/` for bundlers
  that ask for it. Packages ship `src/` as well.
- **`prepack` runs the build.** `pnpm pack` and publishing therefore never
  package a stale `dist/`.
- **One conformance suite, parameterized.** The engines differ in the
  placeholder syntax (`?` for SQLite, `$1` for DuckDB and PGlite), which
  `runDbConformance` takes as an option, so no driver keeps its own copy of the
  common tests. SQLite drivers also run `runSqliteTransactionConformance`.
- **Browser tests have their own Vitest config.** Each browser driver has a
  `vitest.config.ts` that excludes `*.browser.test.ts`, and a
  `vitest.browser.config.ts` that runs only those files, in Chromium. A plain
  `vitest run` therefore never loads WASM or spawns a Worker in Node.js.
- **`tools/consumer-install` packs the real workspace closure.** It packs a
  package together with every workspace package it depends on and installs
  the tarballs together. Otherwise `npm install` would fetch the sibling from
  the registry, and the test would check a mix of local and published code.

## What will surprise you

- **`pnpm run test` packs and installs packages.** `tools/consumer-install`
  runs `pnpm pack` (which runs each package's build) and `npm install` in a
  temporary directory. In CI it takes about 20 seconds; its per-test timeout is
  15 minutes.
- **Browser tests need a Chromium binary.** Without
  `pnpm exec playwright install chromium`, `pnpm run test:browser` fails when
  it launches the browser, before any test runs.
- **The DuckDB browser tests need network access.** They load the DuckDB WASM
  bundle from jsDelivr. The SQLite browser tests load `sqlite3.wasm` from the
  installed package and work offline.
- **A browser driver imports fine under Node.js, then fails.**
  `newBrowserDuckDb()` rejects with `Worker is not defined`;
  `newBrowserSqliteDb()` works in memory under Node.js but rejects a `path` (OPFS needs a Dedicated Worker).
- **`pnpm run test:do` starts a celld node.** It runs `celld dev packages/db-sqlite-do/test-do
  --port <free port> --clean --no-watch` and stops that process at the end. A celld other than
  0.6.x stops it before any test with `test:do needs celld 0.6.x on PATH, found "<version>"`; a
  node that prints no `ready` line within 60 seconds fails it with `celld dev was not ready within
  60 s`.

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `pnpm run build` | `pnpm -r run build` (tsdown in every package, `vite build` for the demo) |
| `pnpm run test` | `pnpm -r run test` (Vitest, Node.js) |
| `pnpm run test:browser` | `test:browser` of `db-sqlite-browser` and `db-duckdb-browser` (Vitest browser mode, Playwright, Chromium) |
| `pnpm run test:do` | builds, then runs `db-sqlite-do`'s Durable Object tests on a real celld (needs celld 0.6.x on PATH) |
| `pnpm run typecheck` | `tsc --noEmit` in every package |
| `pnpm run lint` / `lint:check` | `biome check --write .` / `biome check .` |
| `pnpm run format` / `format:check` | `biome format --write .` / `biome format .` |
| `pnpm changeset` | add a changeset (bump type and changelog text) to a pull request |
| `pnpm --filter <package> <script>` | one package's script, e.g. `pnpm --filter @statewalker/db-sqlite-browser test:browser` |

### Releases

CI never publishes. A maintainer releases from a local checkout with
[changesets](https://github.com/changesets/changesets): the pending changesets
are applied (versions, `CHANGELOG.md`), the packages are published to npm, and
the version commit is pushed to `main`. Add a changeset with `pnpm changeset`
to choose the bump and the changelog text for your change; see
`.changeset/README.md`.

### Files

| Path | Purpose |
| --- | --- |
| `pnpm-workspace.yaml` | workspace globs (`packages/*`, `apps/*`, `tools/*`) and the dependency catalogs |
| `biome.json` | lint and format rules |
| `tsconfig.base.json` | shared TypeScript options |
| `.changeset/` | changesets configuration and pending changesets |
| `.github/workflows/` | the CI workflow (lint, format, typecheck, build, test) |
| `packages/PACKAGE_README.template.md` | starting point for a new package README |

### License

MIT, see [LICENSE](LICENSE).
