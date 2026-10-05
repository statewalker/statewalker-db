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
`@statewalker/db-sqlite-browser` or `@statewalker/db-sqlite-node`. Keeping the
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
- `close()` releases the database. Calls after `close` reject.
- `DbEntry` is `Record<string, unknown>`, the default row type.
- `DbOptions` is `{ path?: string }`: a file path in Node.js, an OPFS path in
  the browser. Without `path`, a driver opens an in-memory database.

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
- **No transaction API and no prepared-statement handles.** The interface
  does not have them; send `BEGIN` / `COMMIT` as SQL through `exec` if you need
  a transaction.
- **`flush` is optional.** It exists for engines that buffer writes, such as
  DuckDB WASM on OPFS, which writes its file only on `CHECKPOINT`. In-memory
  and auto-syncing engines omit it.
- **Dependencies:** none.

## License

MIT
