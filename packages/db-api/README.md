# @statewalker/db-api

## What it is

The database interface that every `@statewalker/db-*` driver implements: a
`Db` with `query`, `exec`, an optional `flush`, and `close`. The package
contains only TypeScript types and has no runtime code.

## Why it exists

Code that stores or searches data should not depend on which engine runs
underneath, or on whether it runs in a browser or in Node.js. Writing it
against `Db` lets the caller pick the engine at startup: one of
`@statewalker/db-duckdb-browser`, `@statewalker/db-duckdb-node`,
`@statewalker/db-sqlite-browser`, `@statewalker/db-sqlite-node`,
`@statewalker/db-sqlite-do` or `@statewalker/db-pglite`. Keeping the
interface in its own package means a library can accept a `Db` without pulling
in any engine.

## How to use

```sh
pnpm add @statewalker/db-api
```

| Import | Gives |
| --- | --- |
| `@statewalker/db-api` | types `Db`, `DbEntry`, `DbOptions` |

Import it with `import type`. The built entry (`dist/index.mjs`) is empty at
runtime.

- `query<T = DbEntry>(sql, params?)` returns `Promise<T[]>`. `params` are
  positional values; the placeholder syntax is the engine's.
- `exec(sql)` runs SQL that returns no rows (DDL, DML). It takes no
  parameters.
- `flush?()` writes buffered changes to durable storage. Only drivers whose
  engine buffers writes implement it; check for it before calling.
- `close()` releases the database, once the calls made before it have
  settled. Calls made after it reject.
- `DbEntry` is `Record<string, unknown>`, the default row type.
- `DbOptions` is `{ path?: string }`: a file path in Node.js, an OPFS path in
  the browser. Without `path`, a driver opens an in-memory database. PGlite
  reads `path` as a data directory; the Durable Object driver takes the DO's
  storage instead of options.

### What every driver guarantees

The JSDoc of `Db` states the contract; `runDbConformance` from the workspace's
`db-tests` checks it on every driver.

| Topic | Guarantee |
| --- | --- |
| Order | Calls run one at a time, in call order, awaited or not. A failed call does not stop the next |
| `close()` | Waits for the calls made before it, then closes |
| Calls after `close()` | Reject with `<driver>: the database is closed` (`db-sqlite`, `db-duckdb-node`, `db-duckdb-browser`, `db-pglite`) |
| `close()` twice | A no-op: the second call resolves once the first has finished |
| BLOB | `Uint8Array` (a `Buffer` on DuckDB for Node.js). DuckDB WASM cannot bind one as a parameter (`TypeError`) |
| Integers | `number` within ±(2^53 - 1), `bigint` beyond, whatever the column type, also inside lists and structs |

Decimals and dates differ by engine, because the engines differ and no
conversion would be lossless:

| Value | DuckDB | PGlite | SQLite |
| --- | --- | --- | --- |
| `DECIMAL` / `NUMERIC` | `number` (nearest double) | exact decimal string (`"1.25"`) | `number` (no decimal type) |
| `DATE`, `TIMESTAMP` | `Date` | `Date` | the ISO 8601 text stored (no date type) |
| `Date` parameter | binds as a timestamp | binds as a timestamp | binds as `date.toISOString()` |

## Examples

Accept any `Db`:

```ts
import type { Db } from "@statewalker/db-api";

export async function countUsers(db: Db): Promise<number> {
  const [row] = await db.query<{ n: number }>("SELECT count(*) AS n FROM users");
  return Number(row?.n ?? 0);
}
```

Flush when the driver supports it:

```ts
import type { Db } from "@statewalker/db-api";

export async function save(db: Db, sql: string): Promise<void> {
  await db.exec(sql);
  await db.flush?.();
}
```

## Internals

- **Types only.** `src/index.ts` has nothing but `export type`, so the build
  emits an empty module. Importing it at runtime succeeds and gives nothing.
- **The lifecycle lives in one place.** The drivers build their `Db` with
  `newSerialisedDb` (DuckDB, PGlite) or `newSerialisedSqliteDb` (SQLite), both
  from `@statewalker/db-sqlite`, which share one call queue; this package stays
  types-only.
- **No transaction API and no prepared-statement handles.** The interface
  does not have them. On a SQLite Db use `inTransaction(db, cb)` from
  `@statewalker/db-sqlite`: a Durable Object rejects SQL `BEGIN` with
  `not authorized`. On DuckDB and PGlite, send `BEGIN; ...; COMMIT` as one
  `exec`.
- **`flush` is optional.** It exists for engines that buffer writes, such as
  DuckDB WASM on OPFS, which writes its file only on `CHECKPOINT`. In-memory
  and auto-syncing engines omit it.
- **Dependencies:** none.

## License

MIT
