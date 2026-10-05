# @statewalker/db-sqlite-node

## What it is

A libSQL/SQLite driver for Node.js that implements `Db` from
`@statewalker/db-api`. It uses `@libsql/client` with a local file or an
in-memory database. libSQL includes FTS5 full-text search and vector search
(`F32_BLOB`, `vector32`, `libsql_vector_idx`, `vector_top_k`).

## Why it exists

It lets code written against `Db` run on SQLite in Node.js, with the same SQL
features that `@statewalker/db-sqlite-browser` has in the browser. Search and
storage code can be built and tested in Node.js and shipped to the browser
unchanged.

## How to use

```sh
pnpm add @statewalker/db-sqlite-node
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-node` | `newNodeSqliteDb`; types `Db`, `DbEntry`, `DbOptions` re-exported from `@statewalker/db-api` | Node.js |

`newNodeSqliteDb(options?)` returns `Promise<Db>`. It opens `file:<path>`, or
`:memory:` without a path. The `Db` implements `query`, `exec` and `close`; it
has no `flush`. Use `?` placeholders.

## Examples

```ts
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

const db = await newNodeSqliteDb({ path: "./data.db" });
await db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
await db.exec("INSERT INTO t VALUES (1), (2)");
const rows = await db.query<{ x: number }>("SELECT x FROM t WHERE x > ?", [1]);
await db.close();
```

## Internals

- **Local only.** The driver builds the client URL itself (`file:<path>` or
  `:memory:`), so remote libSQL servers (`libsql://` URLs with an auth token)
  cannot be reached through it.
- **Rows are libSQL `Row` objects.** Named columns are enumerable; positional
  keys and `length` are also present but non-enumerable. `{ ...row }` and
  `JSON.stringify(row)` give only the named columns, while `row.length` and
  `row[0]` still work.
- **Errors are libSQL's.** A path that cannot be opened rejects with
  `ConnectionFailed("Unable to open connection to local database ...: 14")`.
  Bad SQL rejects with `SQLITE_ERROR: near "...": syntax error`. A call after
  `close()` rejects with `CLIENT_CLOSED: The client is closed`.
- **Dependencies:** `@libsql/client` (the engine), `@statewalker/db-api` (the
  interface types).

## License

MIT
