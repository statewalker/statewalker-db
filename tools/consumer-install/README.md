# @statewalker/consumer-install-tests

Private test package, not published. It checks that the public packages
install and import the way a consumer gets them from npm.

For each public package it runs `pnpm pack` on the package and on the workspace
packages it depends on (each `pack` runs the package's `prepack` build), runs
`npm install` of the tarballs in a temporary project, and imports every export
subpath under Node. Browser-only packages (`db-duckdb-browser`,
`db-sqlite-browser`) are installed but not imported. `db-api` is types-only, so
its import is checked but no runtime exports are expected.

## Run

```sh
pnpm --filter @statewalker/consumer-install-tests test
```

It is also part of the root `pnpm run test`. A run takes minutes; the test
timeout is 15 minutes.
