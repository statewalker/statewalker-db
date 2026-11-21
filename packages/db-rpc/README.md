# @statewalker/db-rpc

## What it is

A `Db` (from `@statewalker/db-api`) over any RPC, with large results paged and a read-only mode.

- **Server** (`newDbRpcServer({ db, readOnly? })`): serves any `Db` as plain method calls.
- **Client** (`newDbRpcClient({ rpc })`): a `Db` whose every call goes through those methods: a
  Durable Object or Workers RPC stub, comlink, postMessage, or the server object itself.

A result moves as **pages keyed by `(streamId, pageId)`**: `query` answers page 0 and the page
count, the client asks for the other pages (several in flight) and puts them back in order. Every
call carries a caller-chosen key, so a call the transport delivers twice runs once.

## Why it exists

`Db.query` returns all rows at once. Over an RPC that would put the whole result in one message,
and transports limit messages (Durable Object RPC refuses one above 32 MiB; JSON transports fail
long before). Paging keeps every message near a fixed size, whatever the result.

The read-only mode gives a reader the full SQL surface without the risk: every call runs in a
transaction that is always rolled back (`inReadOnlyTransaction` from `@statewalker/db-sqlite`), so
a reader may run any `SELECT`, and a write it sends answers inside its call and never persists.
One Db can be served by a read-only server and a read-write server side by side.

The package mirrors `@statewalker/webrun-files-rpc` (keyed chunks, retries, `requestId`), which
does the same for a `FilesApi`.

## How to use

```sh
pnpm add @statewalker/db-rpc @statewalker/db-api
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-rpc` | `newDbRpcServer`, `newDbRpcClient`, `DbRpcError`, `errorCode`; types `DbRpc`, `DbRpcServer`, `DbRpcServerOptions`, `DbRpcClientOptions`, `QueryOptions`, `QueryResult`, `QueryPage`, `RequestOptions`, `DbRpcErrorCode` | any (uses `crypto.randomUUID`) |

### `newDbRpcServer(options)`

| Option | Default | |
| --- | --- | --- |
| `db` | (required) | The `Db` served. The server never closes it: its owner does. |
| `readOnly` | `false` | Run every `query` and `exec` in a transaction that is always rolled back. Needs a `@statewalker/db-sqlite*` Db (0.1.4 or later), not wrapped; any other throws a `TypeError` at once. |
| `pageRows` | 1024 | Rows per page at most. |
| `pageBytes` | 256 KiB | About how many bytes a page holds (UTF-8 text and BLOB bytes exactly, 8 per number); a row larger than this gets a page of its own. |
| `idleTimeout` | 2 min | An open result not read for this long is dropped; a kept answer is forgotten this long after it settled. |
| `maxStreams` | 256 | Open results (of more than one page) at most. Beyond, `query` is refused with `TOO_MANY_STREAMS` before it runs. |
| `maxRequests` | 256 | Answers kept by key at most (the oldest settled one goes first). |
| `sweepInterval` | none | Sweep idle results every this many ms. Without it, every `query` sweeps. |
| `now` | `Date.now` | The clock (tests). |

The server is a `DbRpc` plus `sweep()` (drops idle results, returns how many), `openStreams()`
and `close()` (drops every result, stops the timer; later calls reject with `ABORTED`; the Db stays
open).

### `newDbRpcClient(options)`

| Option | Default | |
| --- | --- | --- |
| `rpc` | (required) | The server's methods, through any transport. |
| `readAhead` | 4 | `readPage` calls in flight while reading a result of several pages. |

The client is a `Db` with `flush` (the served Db's `flush`, or nothing when it has none). It keeps
the `Db` lifecycle: calls run one at a time in call order, whatever order the transport delivers
them in; `close()` waits for them; later calls reject with `db-rpc: the database is closed`;
closing twice is a no-op. Closing the client does not close the served Db.

### The protocol (`DbRpc`)

| Call | Answer |
| --- | --- |
| `query(sql, params?, {streamId?})` | `{streamId, pages, rows}`: page 0 and the page count. A result of one page is not kept open. |
| `readPage(streamId, pageId)` | `{rows, done}`, any page `0 .. pages - 1` of an open result, as often as asked |
| `closeQuery(streamId)` | drops the result (unknown or closed: nothing happens) |
| `exec(sql, {requestId?})` | as `Db.exec` |
| `flush({requestId?})` | the Db's `flush`, if any |

Every argument and result is structured-clonable (strings, numbers, bigints, null, plain objects,
arrays, `Uint8Array`, `Date`).

- **Keys:** `streamId` and `requestId` are chosen by the caller: 16 to 128 characters of
  `[A-Za-z0-9_-]`, random (`crypto.randomUUID()` without dashes); the client sends a fresh one with
  every call. A call delivered again with the same key, concurrently or later, gets the first
  answer (or failure) and does not run again, for `idleTimeout` after it settled and among the
  last `maxRequests` answers. Without a key, a call delivered twice runs twice: an
  `INSERT … RETURNING` inserts twice.
- **Errors:** the Db's own errors pass through as they are. Protocol errors are `DbRpcError` with a
  `code` (`UNKNOWN_STREAM`, `TOO_MANY_STREAMS`, `ABORTED`, `INVALID`) that also leads the message
  (`UNKNOWN_STREAM: …`), since a structured clone keeps only an error's message; `errorCode(e)`
  reads it on either side.

## Examples

### Both ends in one process

```ts
import { newDbRpcClient, newDbRpcServer } from "@statewalker/db-rpc";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

const db = await newNodeSqliteDb();
await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");

const writer = newDbRpcClient({ rpc: newDbRpcServer({ db }) });
await writer.query("INSERT INTO notes (body) VALUES (?)", ["hello"]);

const reader = newDbRpcClient({ rpc: newDbRpcServer({ db, readOnly: true }) });
await reader.query("DELETE FROM notes"); // runs, then is rolled back
console.log(await reader.query("SELECT body FROM notes")); // [{ body: "hello" }]
```

### Served by a Durable Object, called through its stub

```ts
import { DurableObject } from "cloudflare:workers";
import { newDbRpcClient, newDbRpcServer, type DbRpcServer } from "@statewalker/db-rpc";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";

export class Database extends DurableObject {
  #db = newDoSqliteDb(this.ctx.storage);
  #rpc: DbRpcServer = newDbRpcServer({ db: this.#db });
  query(sql: string, params?: unknown[], o?: object) { return this.#rpc.query(sql, params, o); }
  readPage(id: string, k: number) { return this.#rpc.readPage(id, k); }
  closeQuery(id: string) { return this.#rpc.closeQuery(id); }
  exec(sql: string, o?: object) { return this.#rpc.exec(sql, o); }
  flush(o?: object) { return this.#rpc.flush(o); }
}

// In a Worker: the stub has the same methods, so it is the client's `rpc`.
const db = newDbRpcClient({ rpc: env.DATABASE.get(env.DATABASE.idFromName("main")) as never });
```

An open result lives in the server's memory: keep one result's calls on one server (they are,
through one stub).

## Internals

- **Paging:** the server runs the statement through `Db.query` (so the whole result is in its
  memory once) and cuts the rows into pages of at most `pageRows` rows and about `pageBytes`
  bytes. One page is answered with `query` and nothing is kept; more are kept, by `streamId`, until
  `closeQuery`, `idleTimeout` without a `readPage`, or `close()`. The client reads pages
  `1 .. pages - 1` with `readAhead` calls in flight, concatenates them in order, and closes the
  result, also when a page fails.
- **Memory bound:** open results are at most `maxStreams`; kept answers at most `maxRequests`,
  each holding at most one page (the answer to `query` is page 0). A `query` arriving while
  `maxStreams` results are open (counting queries still running) is refused before it runs,
  since whether its result needs a stream is known only after it ran.
- **Read-only:** each `query` and `exec` is its own `inReadOnlyTransaction`, so the result is
  read inside the transaction and served after the rollback. `db-sqlite` refuses statements that
  would end the transaction or reach outside it (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT,
  RELEASE, ATTACH, DETACH, PRAGMA, VACUUM) with
  `db-sqlite: a read-only transaction refuses COMMIT (it would end the transaction or reach outside it)`.
  A Durable Object refuses most of them anyway; on Node.js and in the browser, a `COMMIT` in the
  SQL would otherwise end the transaction and let what follows persist. `flush` runs as usual.
- **Not covered:**
  - An open result lives in one server's memory; a server restart loses it (`UNKNOWN_STREAM`).
  - Per-caller authorization is the transport's job, or a matter of which server a caller
    reaches (a read-only one or a read-write one).
  - Serializing `Uint8Array` and `bigint` for a JSON-only transport is the transport's job.
- **Dependencies:** `@statewalker/db-api` (types) and `@statewalker/db-sqlite`
  (`inReadOnlyTransaction`).

## Tests

`pnpm --filter @statewalker/db-rpc test` (build the workspace first).

| File | Covers |
| --- | --- |
| `conformance.test.ts` | the shared `runDbConformance` suite on the client: over db-sqlite-do (the node:sqlite fake of `ctx.storage`) directly and through a transport that clones, delays, reorders and repeats calls; over db-sqlite-node with file persistence |
| `server.test.ts` | pages by rows and by bytes (BLOBs, multi-byte text, a row larger than a page), pages out of order and again, keyed retries of `query`, `exec` and `flush` (failures too, forgotten after `idleTimeout` and beyond `maxRequests`), refused ids, idle sweeps, `maxStreams`, `close()`, error codes across a clone |
| `client.test.ts` | many pages read in order and closed, `readAhead`, fresh keys, a failing page closing the result, call order over a reordering transport, BLOBs and bigints, the close lifecycle |
| `read-only.test.ts` | a read-only server on db-sqlite-do and db-sqlite-node: reads across pages, no write persisting through `query` or `exec`, refused transaction control, a Db without the hook refused, read-only and read-write servers on one Db |

## License

MIT
