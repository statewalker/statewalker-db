# @statewalker/consumer-install-tests

## What it is

A private Vitest suite (not published) that installs each public package of
this workspace the way an npm consumer gets it, from a packed tarball, and
checks that it imports. It catches packages that build and pass their own tests
but are broken once published: missing `dist/` files, `exports` that point at
raw TypeScript, or `workspace:` specifiers left in the packed manifest.

## The shape: pack the closure, install, probe

```
for each target in PACKAGES (consumer-install.test.ts):
  check: its subpaths list equals the keys of its exports map
  closure = target + every packages/* package it depends on (transitively)
  pnpm pack each package in the closure     (prepack runs its build)
  npm install all tarballs in a temp dir
  check: exports targets exist in the tarball, none names raw .ts
  check: import every export subpath under Node.js (unless browserOnly)
  check: packed package.json has no workspace:/catalog: specifier
```

Targets: `@statewalker/db-api` (types only), `db-duckdb-node`,
`db-sqlite-node`, `db-duckdb-browser` and `db-sqlite-browser` (both browser
only: installed and checked, not imported).

## How to run it

From the repository root:

1. `pnpm install`
2. `pnpm --filter @statewalker/consumer-install-tests test`

It also runs as part of the root `pnpm run test`. It needs `pnpm` and `npm` on
`PATH`.

## Why it is the way it is

- **It packs the real workspace closure.** The set of packages to pack is
  built by reading `packages/`, not from the target list. If a sibling were
  left out, `pnpm pack` would turn the target's `workspace:^` dependency on it
  into a version number, and `npm install` would fetch that version from the
  registry. The test would then check a mix of local and published code, and
  fail outright once a local version is ahead of npm.
- **It checks the installed `exports` map, not just that `dist/` exists.** For
  browser-only packages the import probe never runs, so this check is their
  only coverage. Every file named by any condition must be in the tarball. No
  condition except `source` may name a `.ts` file: `source` is a bundler hint
  that no runtime resolves.
- **`db-api` is `typesOnly`, not `browserOnly`.** It imports under Node.js and
  exports nothing at runtime. The probe still imports it; only the "exports
  something" assertion is skipped. A guard test fails if a `typesOnly` package
  starts exporting runtime values, so the flag cannot outlive its reason.
- **Long timeouts.** Each test runs `pnpm pack` (and so a build) for a whole
  closure and a real `npm install`. Vitest's 5-second default is far too
  short; `vitest.config.ts` sets test and hook timeouts to 15 minutes.

## What will surprise you

- **It builds the packages as a side effect.** `pnpm pack` runs each
  package's `prepack` (`pnpm run build`), which rewrites `dist/`.
- **A raw TypeScript entry fails here, not in the package's own tests.** Under
  Node.js, importing `.ts` from `node_modules` fails with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. The test shows it as
  `Command failed: node probe.mjs` with that code in the output.
- **New packages are not checked automatically.** A new public package needs
  an entry in `PACKAGES` in `consumer-install.test.ts`. Until then it is only
  packed as part of other packages' closures. A new `exports` subpath on a
  listed package fails "subpaths match the package's exports map" until it is
  added to that entry's `subpaths`.
- **Tarballs are written into `packages/<dir>/` for a moment.** `pnpm pack`
  writes there and the test deletes them after `npm install`. An interrupted
  run can leave `*.tgz` files behind.

## Reference

| File | Purpose |
| --- | --- |
| `consumer-install.test.ts` | the `PACKAGES` target list and all checks |
| `vitest.config.ts` | Node environment, `*.test.ts`, 15-minute timeouts |
| `package.json` | `test` script (`vitest run`) |
