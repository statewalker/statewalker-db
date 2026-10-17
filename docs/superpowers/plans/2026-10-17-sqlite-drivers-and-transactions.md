# SQLite drivers and transactions (P0 + P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `Db` from `@statewalker/db-api` (unchanged) SQLite transactions through a new `@statewalker/db-sqlite`. Move the Node driver to `node:sqlite` and the browser driver to `@sqlite.org/sqlite-wasm` (OPFS `opfs-sahpool` in a Dedicated Worker). Add a Durable Object driver with a faithful fake and a real-`celld dev` test harness, plus a PGlite driver.

**Architecture:**
- **The engine seam.** Every SQLite driver wraps a small synchronous engine (`all`, `exec`, `close`, optionally `transaction`) in `newSerialisedSqliteDb`. That function owns the mutex, the closed state and the transaction hook stored under `Symbol.for("@statewalker/db-sqlite:transaction")`.
- **`inTransaction(db, cb)`** finds that hook. A Db without the hook is rejected; that covers wrappers, other engines and a nested call on the `tx` handle.
- **Transaction behaviour is specified once** as vitest-free scenarios in `@statewalker/db-tests`. Those scenarios run against:
  - every SQLite driver under vitest;
  - the fake DO storage under vitest;
  - real DO SQLite inside a `celld dev` Durable Object.

**Tech Stack:** TypeScript (`module: Preserve`), pnpm 10 workspace with catalog, tsdown, vitest 5 (+ browser mode, Playwright Chromium), biome, changesets, `node:sqlite` (Node 24), `@sqlite.org/sqlite-wasm` 3.53.0-build1, `@electric-sql/pglite` ^0.5.8, celld 0.6.x.

**Spec:** `~/workspace-statewalker/notes/2026/2026-10/2026-10-17/grill-sqlite-db-indexing.md`. This plan covers D1, D2, D3 and D5 (the `db-pglite` part), the D14 Db-level seams with DO tested both ways, and D15 phases P0 and P1.

**Where to run:** in `workspaces/statewalker-db` of the thematic umbrella's feature worktree (D16): umbrella `umbrella-sqlite-indexing` (submodules statewalker-db, webrun-files, statewalker-search), feature worktree `umbrella-sqlite-indexing__sqlite-db`, branch `feat/sqlite-db` in every repo. It is created at execution time with the `umbrella-dev-flow` skill (Phases 1–3), before Task 1; no plan task creates it. All paths below are relative to the statewalker-db repository root.

## Global Constraints

- `packages/db-api/src/*` is **not edited**. `Db = { query, exec, flush?, close }` stays exactly as it is (D1).
- **Async only.** No sync API is exported for consumers. `SqliteEngine` is the internal seam drivers implement; it is exported only so drivers in other packages can use it.
- **Hook key:** `Symbol.for("@statewalker/db-sqlite:transaction")`.
- **Fixed cross-plan names** (other plans import these; do not rename):
  - `SQLITE_TRANSACTION`, `SqliteTransactionHook`, `inTransaction`, `SqliteEngine` and `newSerialisedSqliteDb` from `@statewalker/db-sqlite`;
  - `newNodeSqliteDb`;
  - `newBrowserSqliteDb` / `BrowserDbOptions`;
  - `newDoSqliteDb` / `DoSqlStorage`;
  - `runSqliteTransactionConformance(makeDb: () => Promise<Db>)`;
  - `newPgliteDb(options?: { path?: string; extensions?: Record<string, unknown> }): Promise<Db>`.
- **Transaction callback rules:** no external I/O inside, and the callback must be idempotent (Durable Objects may retry it).
- **DO SQLite limits** (probed on celld 0.5.1):
  - at most 100 bound parameters (200 is rejected with "too many SQL variables");
  - a BLOB of 1.9 MB is accepted and 2.5 MB is rejected ("string or blob too big");
  - `BEGIN`, `SAVEPOINT` and `PRAGMA` are "not authorized";
  - there is a 15 s operation deadline.
- **Placeholders:** `?` for SQLite and `$1` for PGlite.
- **Runtimes:** Node.js 24 (`node:sqlite`, SQLite 3.53.x). The `@sqlite.org/sqlite-wasm` catalog version is `3.53.0-build1` (already in `pnpm-workspace.yaml`).
- **Version bumps for breaking driver changes are 0.x minors:**
  - `db-sqlite-node` 0.2.1 → 0.3.0;
  - `db-sqlite-browser` 0.1.4 → 0.2.0.

  The spec says "major". Under 0.x semver the breaking bump is the minor, the same as D5's `indexer-pglite` 0.2 → 0.3.
- **New packages** start at `"version": "0.0.0"` and get a `minor` changeset, which makes them 0.1.0.
- **libSQL is removed** from the catalog and from every package (D3).
- **Files:** kebab-case file names. A README changes in the same commit as the behaviour it describes, following the user's README rules (What it is / Why it exists / How to use / Examples / Internals / License, with headings written as claims).
- **Tests:** only at public seams, against real implementations. No mocks of the code under test. The DO fake is a stand-in for Cloudflare's platform, not for our code.
- **Each task ends with, in this order:**
  1. its tests;
  2. `pnpm typecheck`;
  3. `pnpm biome check --write --unsafe`;
  4. a commit.
- **celld:** `test:do` requires celld 0.6.x on `PATH`. Only ever kill the `celld` child process the harness spawned. Never `pkill celld`.

## Review Focus

1. **Multi-statement `exec`.** A caller passes `"CREATE TABLE a(x); CREATE TABLE b(y)"` to `exec`. Expected: every statement runs on every SQLite driver.
   - `node:sqlite`'s `prepare` silently ignores everything after the first statement, so an engine must never route `exec` through `prepare`.
   - Pinned by the scenario "exec runs every statement of a multi-statement string" (Task 1) and by the platform probe `multiStatementExec` (Tasks 3–4).
2. **A transaction handle used after its transaction finished.** A closure keeps `tx` and fires later. Expected: the call rejects with "transaction is finished", and does not write outside any transaction. Scenario in Task 1.
3. **A plain write issued while another flow's transaction is open.** Expected: it waits, and it survives that transaction's rollback. It must not join the transaction and be rolled back with it. Scenario in Task 1.
4. **A persistent `path` on the browser main thread.** Expected: an immediate, explicit rejection that names the Dedicated Worker requirement. No silent in-memory fallback, and no OPFS error later. Tests in Task 5.
5. **`close()` while a transaction is running.** Expected: `close` waits for the transaction to finish and the transaction's promise resolves. It must not cut the engine from under it. Scenario in Task 1.

---

## File Structure

```
pnpm-workspace.yaml                         catalog: drop @libsql/*, add @electric-sql/pglite(+pgvector)
package.json                                description; scripts test:do
README.md                                   layout, run steps, surprises
.gitignore                                  .celld/
tools/consumer-install/consumer-install.test.ts   PACKAGES: + db-sqlite, db-sqlite-do (+./fake), db-pglite
packages/db-sqlite/                         NEW  inTransaction + newSerialisedSqliteDb
  src/index.ts
  src/sqlite-transaction.ts                 SQLITE_TRANSACTION, SqliteTransactionHook, inTransaction
  src/serialised-sqlite-db.ts               SqliteEngine, newSerialisedSqliteDb (lock, closed flag, hook)
packages/db-tests/
  src/suites/sqlite-transaction-scenarios.ts        vitest-free scenarios (also bundled into the DO worker)
  src/suites/sqlite-transaction-conformance.suite.ts runSqliteTransactionConformance (vitest runner)
  src/suites/sqlite-transaction-conformance.test.ts runs the suite on newSerialisedSqliteDb + node:sqlite
  src/suites/index.ts                       exports
packages/db-sqlite-node/src/node-sqlite-db.ts       node:sqlite engine
packages/db-sqlite-browser/src/browser-sqlite-db.ts sqlite-wasm engine, opfs-sahpool in a worker
packages/db-sqlite-browser/test/opfs-test-worker.ts Dedicated Worker fixture for the persistence test
packages/db-sqlite-do/                      NEW  DO driver
  src/index.ts, src/do-sqlite-db.ts         newDoSqliteDb, DoSqlStorage
  src/fake.ts, src/fake-do-storage.ts       "./fake": newFakeDoStorage (node:sqlite, probed limits)
  src/do-sqlite-db.test.ts                  Db + transaction conformance on the fake, probe parity
  tsdown.config.ts                          two entries
  vitest.config.ts, vitest.do.config.ts     unit vs real-celld configs
  test-do/platform-probe.ts                 probeDoSqlite + PROBE_EXPECTATIONS (vitest-free)
  test-do/wrangler.jsonc, test-do/worker.ts DO exposing ops, scenarios and the probe
  test-do/scenarios.ts                      SCENARIOS: transaction scenarios + smoke scenarios other packages register (P2, P3)
  test-do/global-setup.ts                   spawns celld dev, provides its URL
  test-do/do-conformance.do.test.ts         the real-DO suite
packages/db-pglite/                         NEW  newPgliteDb
```

---

### Task 1: `@statewalker/db-sqlite` and the SQLite transaction scenarios

**Files:**
- Create: `packages/db-sqlite/package.json`, `packages/db-sqlite/tsconfig.json`, `packages/db-sqlite/README.md`, `packages/db-sqlite/src/index.ts`, `packages/db-sqlite/src/sqlite-transaction.ts`, `packages/db-sqlite/src/serialised-sqlite-db.ts`
- Create: `packages/db-tests/src/suites/sqlite-transaction-scenarios.ts`, `packages/db-tests/src/suites/sqlite-transaction-conformance.suite.ts`, `packages/db-tests/src/suites/sqlite-transaction-conformance.test.ts`
- Modify: `packages/db-tests/src/suites/index.ts`, `packages/db-tests/package.json` (dependency + export subpath), `packages/db-tests/README.md`
- Modify: `tools/consumer-install/consumer-install.test.ts` (PACKAGES)
- Create: `.changeset/db-sqlite-transactions.md`

**Interfaces:**
- **Consumes:** `Db`, `DbEntry` from `@statewalker/db-api`.
- **Produces, from `@statewalker/db-sqlite`:**
  ```ts
  export const SQLITE_TRANSACTION: unique symbol; // Symbol.for("@statewalker/db-sqlite:transaction")
  export type SqliteTransactionHook = <T>(cb: (tx: Db) => Promise<T>) => Promise<T>;
  export function inTransaction<T>(db: Db, cb: (tx: Db) => Promise<T>): Promise<T>;
  export type SqliteEngine = {
    all(sql: string, params: unknown[]): Record<string, unknown>[];
    exec(sql: string): void;
    close(): void;
    transaction?<T>(fn: () => Promise<T>): Promise<T>; // optional: platforms without SQL-level BEGIN (DO)
  };
  export function newSerialisedSqliteDb(engine: SqliteEngine): Db;
  ```
- **Produces, from `@statewalker/db-tests`:**
  - `runSqliteTransactionConformance(makeDb: () => Promise<Db>): void`;
  - `sqliteTransactionScenarios: SqliteTransactionScenario[]` and `type SqliteTransactionScenario = { name: string; run(db: Db): Promise<void> }`, also exported vitest-free from the subpath `@statewalker/db-tests/sqlite-transaction-scenarios`.

- [ ] **Step 1: Scaffold `packages/db-sqlite`**

`packages/db-sqlite/package.json`:

```json
{
  "name": "@statewalker/db-sqlite",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "description": "SQLite transactions for @statewalker/db-api: inTransaction(db, cb) and the serialised engine wrapper every SQLite driver uses.",
  "bugs": { "url": "https://github.com/statewalker/statewalker-db/issues" },
  "homepage": "https://github.com/statewalker/statewalker-db/tree/main/packages/db-sqlite#readme",
  "author": { "name": "Mikhail Kotelnikov", "email": "mikhail.kotelnikov@gmail.com" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/statewalker/statewalker-db.git",
    "directory": "packages/db-sqlite"
  },
  "exports": {
    ".": { "source": "./src/index.ts", "types": "./dist/index.d.mts", "import": "./dist/index.mjs" }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsdown",
    "prepack": "pnpm run build",
    "dev": "tsdown --watch",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit",
    "clean": "rimraf dist",
    "lint": "biome check --write .",
    "format": "biome format --write ."
  },
  "dependencies": { "@statewalker/db-api": "workspace:^" },
  "devDependencies": {
    "rimraf": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "sideEffects": false,
  "publishConfig": { "access": "public" }
}
```

`packages/db-sqlite/tsconfig.json`: copy `packages/db-sqlite-node/tsconfig.json` verbatim. It is the same strict config with `types: ["node"]`; keep `types: ["node"]` because the repo's other packages do and `@types/node` is in the root devDependencies.

- [ ] **Step 2: Write the scenarios (the failing tests)**

`packages/db-tests/src/suites/sqlite-transaction-scenarios.ts`. This file must not import vitest, because it is bundled into the DO worker in Task 4.

```ts
/**
 * SQLite transaction behaviour as plain async scenarios, with no test framework
 * import, so the same file runs under Vitest (runSqliteTransactionConformance)
 * and inside a real Durable Object (the db-sqlite-do `test:do` worker).
 * Each scenario gets a fresh, empty Db and throws on the first failed check.
 */
import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";

export type SqliteTransactionScenario = { name: string; run(db: Db): Promise<void> };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`scenario check failed: ${message}`);
}

async function count(db: Db, where = "1"): Promise<number> {
  const rows = await db.query<{ n: number }>(`SELECT count(*) AS n FROM t WHERE ${where}`);
  return Number(rows[0]?.n);
}

const setup = (db: Db) => db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, b BLOB)");

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const sqliteTransactionScenarios: SqliteTransactionScenario[] = [
  {
    name: "commits every statement and returns the callback's value",
    async run(db) {
      await setup(db);
      const value = await inTransaction(db, async (tx) => {
        await tx.query("INSERT INTO t (k) VALUES (?)", ["a"]);
        await tx.query("INSERT INTO t (k) VALUES (?)", ["b"]);
        return 42;
      });
      check(value === 42, `returned ${value}`);
      check((await count(db)) === 2, "both rows are committed");
    },
  },
  {
    name: "rolls back every statement when the callback throws after a timer",
    async run(db) {
      await setup(db);
      const boom = new Error("boom");
      let caught: unknown;
      try {
        await inTransaction(db, async (tx) => {
          await tx.query("INSERT INTO t (k) VALUES ('a')");
          await sleep(5);
          await tx.query("INSERT INTO t (k) VALUES ('b')");
          throw boom;
        });
      } catch (error) {
        caught = error;
      }
      check(caught === boom, "the callback's own error is rethrown");
      check((await count(db)) === 0, "no row survives the rollback");
    },
  },
  {
    name: "an outer call issued during a transaction waits for its commit",
    async run(db) {
      await setup(db);
      const first = inTransaction(db, async (tx) => {
        await tx.query("INSERT INTO t (k) VALUES ('a')");
        await sleep(10);
        await tx.query("INSERT INTO t (k) VALUES ('a')");
      });
      const second = inTransaction(db, async (tx) => {
        const rows = await tx.query<{ n: number }>("SELECT count(*) AS n FROM t");
        return Number(rows[0]?.n);
      });
      const plain = count(db);
      await first;
      check((await second) === 2, "the second transaction saw both rows");
      check((await plain) === 2, "a plain query saw both rows");
    },
  },
  {
    name: "a plain write issued during a transaction survives its rollback",
    async run(db) {
      await setup(db);
      const failing = inTransaction(db, async (tx) => {
        await tx.query("INSERT INTO t (k) VALUES ('tx')");
        await sleep(10);
        throw new Error("rollback");
      });
      const plain = db.query("INSERT INTO t (k) VALUES ('plain')");
      await failing.catch(() => undefined);
      await plain;
      check((await count(db, "k = 'plain'")) === 1, "the plain write is kept");
      check((await count(db, "k = 'tx'")) === 0, "the transaction's write is rolled back");
    },
  },
  {
    name: "nested inTransaction on the transaction handle rejects",
    async run(db) {
      await setup(db);
      let nested: unknown;
      await inTransaction(db, async (tx) => {
        try {
          await inTransaction(tx, async () => undefined);
        } catch (error) {
          nested = error;
        }
        await tx.query("INSERT INTO t (k) VALUES ('outer')");
      });
      check(/nest/i.test(errorText(nested)), `nested call rejected: ${errorText(nested)}`);
      check((await count(db)) === 1, "the outer transaction still commits");
    },
  },
  {
    name: "the transaction handle rejects once the transaction is finished",
    async run(db) {
      await setup(db);
      let saved: Db | undefined;
      await inTransaction(db, async (tx) => {
        saved = tx;
      });
      let late: unknown;
      try {
        await saved?.query("INSERT INTO t (k) VALUES ('late')");
      } catch (error) {
        late = error;
      }
      check(/finished/i.test(errorText(late)), `late use rejected: ${errorText(late)}`);
      check((await count(db)) === 0, "the late write did not happen");
    },
  },
  {
    name: "a Db wrapped by the caller is rejected, not run without a transaction",
    async run(db) {
      const wrapped: Db = {
        query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      };
      let caught: unknown;
      try {
        await inTransaction(wrapped, async () => undefined);
      } catch (error) {
        caught = error;
      }
      check(/wrap/i.test(errorText(caught)), `wrapper rejected: ${errorText(caught)}`);
    },
  },
  {
    name: "changes() and RETURNING report the rows a statement touched",
    async run(db) {
      await setup(db);
      await db.exec("INSERT INTO t (k) VALUES ('a'), ('b'), ('c')");
      await inTransaction(db, async (tx) => {
        await tx.query("UPDATE t SET k = 'z' WHERE id <= 2");
        const changed = await tx.query<{ n: number }>("SELECT changes() AS n");
        check(Number(changed[0]?.n) === 2, `changes() = ${changed[0]?.n}`);
        const inserted = await tx.query<{ id: number }>("INSERT INTO t (k) VALUES ('r') RETURNING id");
        check(inserted.length === 1 && Number(inserted[0]?.id) === 4, "RETURNING gives the new id");
      });
    },
  },
  {
    name: "a BLOB comes back as a Uint8Array with the same bytes",
    async run(db) {
      await setup(db);
      const bytes = new Uint8Array([0, 1, 127, 255]);
      await db.query("INSERT INTO t (k, b) VALUES ('plain', ?)", [bytes]);
      await inTransaction(db, (tx) => tx.query("INSERT INTO t (k, b) VALUES ('tx', ?)", [bytes]));
      const rows = await db.query<{ b: unknown }>("SELECT b FROM t ORDER BY id");
      for (const row of rows) {
        check(row.b instanceof Uint8Array, `BLOB read back as ${Object.prototype.toString.call(row.b)}`);
        check(Array.from(row.b as Uint8Array).join() === "0,1,127,255", "BLOB bytes are unchanged");
      }
    },
  },
  {
    name: "more than 100 ids bind as one JSON parameter through json_each",
    async run(db) {
      await setup(db);
      const ids = Array.from({ length: 150 }, (_, i) => i + 1);
      await db.query("INSERT INTO t (id) SELECT value FROM json_each(?)", [JSON.stringify(ids)]);
      const wanted = JSON.stringify(ids.slice(0, 120));
      const rows = await db.query<{ n: number }>(
        "SELECT count(*) AS n FROM t WHERE id IN (SELECT value FROM json_each(?))",
        [wanted],
      );
      check(Number(rows[0]?.n) === 120, `json_each matched ${rows[0]?.n}`);
    },
  },
  {
    name: "exec runs every statement of a multi-statement string",
    async run(db) {
      await db.exec("CREATE TABLE m1 (a INTEGER); CREATE TABLE m2 (a INTEGER)");
      await db.exec("INSERT INTO m2 VALUES (1)");
      const rows = await db.query<{ a: number }>("SELECT a FROM m2");
      check(rows.length === 1, "the second statement created m2");
    },
  },
  {
    name: "close waits for a running transaction to finish",
    async run(db) {
      await setup(db);
      const running = inTransaction(db, async (tx) => {
        await sleep(10);
        await tx.query("INSERT INTO t (k) VALUES ('late')");
        return "done";
      });
      await db.close();
      check((await running) === "done", "the transaction finished before close");
    },
  },
];
```

`packages/db-tests/src/suites/sqlite-transaction-conformance.suite.ts`:

```ts
import type { Db } from "@statewalker/db-api";
import { describe, it } from "vitest";
import { sqliteTransactionScenarios } from "./sqlite-transaction-scenarios.js";

/** Register every SQLite transaction scenario for one driver; `makeDb` returns a fresh, empty Db. */
export function runSqliteTransactionConformance(makeDb: () => Promise<Db>): void {
  describe("SQLite transaction conformance", () => {
    for (const scenario of sqliteTransactionScenarios) {
      it(scenario.name, async () => {
        const db = await makeDb();
        try {
          await scenario.run(db);
        } finally {
          await db.close();
        }
      });
    }
  });
}
```

`packages/db-tests/src/suites/sqlite-transaction-conformance.test.ts`. This runs the suite on the real `newSerialisedSqliteDb` over a real `node:sqlite` engine. It is a test fixture, not a mock; `db-sqlite-node` is not used because it devDepends on `db-tests`, which would make a cycle.

```ts
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";
import { runSqliteTransactionConformance } from "./sqlite-transaction-conformance.suite.js";

runSqliteTransactionConformance(async () => {
  const db = new DatabaseSync(":memory:");
  return newSerialisedSqliteDb({
    all: (sql, params) => db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[],
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
});
```

`packages/db-tests/src/suites/index.ts` becomes:

```ts
export {
  type MakeDb,
  type RunDbConformanceOptions,
  runDbConformance,
} from "./db-conformance.suite.js";
export { runSqliteTransactionConformance } from "./sqlite-transaction-conformance.suite.js";
export {
  type SqliteTransactionScenario,
  sqliteTransactionScenarios,
} from "./sqlite-transaction-scenarios.js";
```

`packages/db-tests/package.json`:
- add `"@statewalker/db-sqlite": "workspace:^"` to `dependencies`;
- set `exports` to:

```json
"exports": {
  ".": "./src/index.ts",
  "./sqlite-transaction-scenarios": "./src/suites/sqlite-transaction-scenarios.ts"
},
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm install && pnpm --filter @statewalker/db-tests test`
Expected: FAIL. `@statewalker/db-sqlite` has no `src/index.ts`, so the run reports "Failed to resolve entry for package" or "Cannot find module".

- [ ] **Step 4: Implement `@statewalker/db-sqlite`**

`packages/db-sqlite/src/sqlite-transaction.ts`:

```ts
import type { Db } from "@statewalker/db-api";

/** Key under which a SQLite Db carries its transaction hook. Shared across bundles via Symbol.for. */
export const SQLITE_TRANSACTION: unique symbol = Symbol.for("@statewalker/db-sqlite:transaction");

/** Runs `cb` inside one transaction of the Db that carries it. */
export type SqliteTransactionHook = <T>(cb: (tx: Db) => Promise<T>) => Promise<T>;

const NO_HOOK =
  "inTransaction: this Db has no SQLite transaction hook. It is not a @statewalker/db-sqlite* Db, " +
  "or it wraps one (a wrapper object loses the hook - pass the driver's Db itself), " +
  "or it is the handle of a running transaction (nesting is not supported).";

/**
 * Run `cb` in one SQLite transaction: every statement issued through `tx` commits together, or
 * none does if `cb` throws. Other calls on `db` wait until the transaction ends. `cb` must not do
 * external I/O and must be idempotent: a Durable Object may run it more than once.
 */
export function inTransaction<T>(db: Db, cb: (tx: Db) => Promise<T>): Promise<T> {
  const hook = (db as { [SQLITE_TRANSACTION]?: SqliteTransactionHook })[SQLITE_TRANSACTION];
  if (typeof hook !== "function") return Promise.reject(new Error(NO_HOOK));
  return hook(cb);
}
```

`packages/db-sqlite/src/serialised-sqlite-db.ts`:

```ts
import type { Db, DbEntry } from "@statewalker/db-api";
import { SQLITE_TRANSACTION, type SqliteTransactionHook } from "./sqlite-transaction.js";

/**
 * The synchronous engine a SQLite driver wraps. `all` returns rows (BLOBs as Uint8Array) and must
 * run exactly one statement; `exec` runs every statement of a string. `transaction`, when present,
 * replaces `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` (Durable Objects forbid them in SQL).
 */
export type SqliteEngine = {
  all(sql: string, params: unknown[]): Record<string, unknown>[];
  exec(sql: string): void;
  close(): void;
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
};

function newLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Wrap an engine as a `Db` whose calls run one at a time, in call order, and which carries the
 * `inTransaction` hook. The `tx` handed to a transaction callback bypasses the queue, has no hook
 * (so nesting is rejected) and rejects once its transaction has finished.
 */
export function newSerialisedSqliteDb(engine: SqliteEngine): Db {
  const lock = newLock();
  let closed = false;
  const live = () => {
    if (closed) throw new Error("db-sqlite: the database is closed");
  };
  const runTransaction =
    engine.transaction?.bind(engine) ??
    (async <T>(fn: () => Promise<T>): Promise<T> => {
      engine.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        engine.exec("COMMIT");
        return result;
      } catch (error) {
        engine.exec("ROLLBACK");
        throw error;
      }
    });

  const transaction: SqliteTransactionHook = (cb) =>
    lock(async () => {
      live();
      let finished = false;
      const open = () => {
        if (finished) throw new Error("db-sqlite: the transaction is finished; use the outer Db");
      };
      const tx: Db = {
        async query<T = DbEntry>(sql: string, params: unknown[] = []): Promise<T[]> {
          open();
          return engine.all(sql, params) as T[];
        },
        async exec(sql: string): Promise<void> {
          open();
          engine.exec(sql);
        },
        async close(): Promise<void> {
          throw new Error("db-sqlite: close the outer Db, not the transaction handle");
        },
      };
      try {
        return await runTransaction(() => cb(tx));
      } finally {
        finished = true;
      }
    });

  return {
    query: <T = DbEntry>(sql: string, params: unknown[] = []) =>
      lock(async () => {
        live();
        return engine.all(sql, params) as T[];
      }),
    exec: (sql: string) =>
      lock(async () => {
        live();
        engine.exec(sql);
      }),
    close: () =>
      lock(async () => {
        if (closed) return;
        closed = true;
        engine.close();
      }),
    [SQLITE_TRANSACTION]: transaction,
  } as Db;
}
```

`packages/db-sqlite/src/index.ts`:

```ts
export {
  newSerialisedSqliteDb,
  type SqliteEngine,
} from "./serialised-sqlite-db.js";
export {
  inTransaction,
  SQLITE_TRANSACTION,
  type SqliteTransactionHook,
} from "./sqlite-transaction.js";
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `pnpm install && pnpm --filter @statewalker/db-sqlite build && pnpm --filter @statewalker/db-tests test`
Expected: PASS. All 12 "SQLite transaction conformance" tests pass.

- [ ] **Step 6: README, consumer-install, changeset**

`packages/db-sqlite/README.md`:

````markdown
# @statewalker/db-sqlite

## What it is

Transactions for SQLite databases behind `Db` from `@statewalker/db-api`:
`inTransaction(db, cb)` runs `cb` so that every statement issued through its `tx` handle commits
together or not at all. It also holds `newSerialisedSqliteDb`, the wrapper every SQLite driver
(`db-sqlite-node`, `db-sqlite-browser`, `db-sqlite-do`) builds its `Db` with.

## Why it exists

`Db` has no transaction method, and SQLite runtimes disagree on how to open one: Node.js and the
browser accept `BEGIN IMMEDIATE`, while a Durable Object rejects `BEGIN` ("not authorized") and
only offers `storage.transaction(async fn)`. Keeping transactions here leaves `Db` unchanged for
every engine, and gives SQLite callers one call that works in all three runtimes.

## How to use

```sh
pnpm add @statewalker/db-sqlite
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite` | `inTransaction`, `newSerialisedSqliteDb`, `SQLITE_TRANSACTION`; types `SqliteEngine`, `SqliteTransactionHook` | any |

`inTransaction(db, cb)` returns what `cb` returns. If `cb` throws, everything it wrote is rolled
back and the same error is rethrown. While it runs, other calls on `db` wait for it.

## Examples

```ts
import { inTransaction } from "@statewalker/db-sqlite";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";

const db = await newNodeSqliteDb({ path: "./data.db" });
const id = await inTransaction(db, async (tx) => {
  const [row] = await tx.query<{ id: number }>("INSERT INTO docs (body) VALUES (?) RETURNING id", ["x"]);
  await tx.query("INSERT INTO log (doc_id) VALUES (?)", [row?.id]);
  return row?.id;
});
```

## Internals

- **The hook travels on the Db object.** `newSerialisedSqliteDb` stores the transaction function
  under `Symbol.for("@statewalker/db-sqlite:transaction")`; `inTransaction` looks it up. A Db
  without it rejects with
  `inTransaction: this Db has no SQLite transaction hook. ...`. That happens for a DuckDB or PGlite
  Db, for **an object that wraps a SQLite Db** (copying `query`/`exec`/`close` drops the hook —
  pass the driver's Db, or a spread copy `{ ...db }`, which keeps symbol keys), and for the `tx`
  handle itself: **nested transactions are not supported**.
- **One call at a time.** Every `query`, `exec`, `close` and transaction goes through one queue,
  in call order. A plain `db.exec` issued while another flow's transaction is open waits; it never
  joins that transaction, so a rollback cannot take it down. `close` waits for a running
  transaction.
- **The `tx` handle expires.** After the callback settles, `tx.query` rejects with
  `db-sqlite: the transaction is finished; use the outer Db`; `tx.close` always rejects.
- **Callback rules.** No external I/O inside `cb` (the queue is held for its whole duration), and
  `cb` must be idempotent: Durable Objects may run it again.
- **Row counts.** There is no "rows changed" result: use `SELECT changes()` or `RETURNING` inside
  the transaction. Id lists longer than 100 go in one JSON parameter through `json_each(?)` —
  Durable Objects reject more than 100 bound parameters.
- **`SqliteEngine` is the driver seam.** `all` must run exactly one statement and return BLOBs as
  `Uint8Array`; `exec` must run every statement of the string; `transaction` is given only by
  engines that cannot run `BEGIN IMMEDIATE`.
- **Dependencies:** `@statewalker/db-api` (types only).

## License

MIT
````

Edit `packages/db-tests/README.md`:
- In "## What it is", replace "one Vitest suite, `runDbConformance`," with "two Vitest suites, `runDbConformance` and `runSqliteTransactionConformance`,".
- Before "## Examples", add:

```markdown
`runSqliteTransactionConformance(makeDb)` registers a `describe("SQLite transaction
conformance")` block for SQLite drivers (`makeDb: () => Promise<Db>`, a fresh empty Db each
time). Its scenarios are plain async functions with no Vitest import, exported as
`sqliteTransactionScenarios` and from the subpath
`@statewalker/db-tests/sqlite-transaction-scenarios`, so a Durable Object worker can bundle
and run the very same checks against real DO SQLite.
```

- Under "## Internals", add the bullet: "**The transaction scenarios are vitest-free on purpose.** They throw `scenario check failed: ...` on the first failed check. The `db-sqlite-do` `test:do` harness runs them inside a Durable Object, where Vitest cannot run."

`tools/consumer-install/consumer-install.test.ts`: add `{ name: "@statewalker/db-sqlite", dir: "db-sqlite", subpaths: ["."] },` after the `db-api` entry.

`.changeset/db-sqlite-transactions.md`:

```markdown
---
"@statewalker/db-sqlite": minor
---

New package: `inTransaction(db, cb)` for SQLite `Db`s and `newSerialisedSqliteDb(engine)`, the queue + transaction-hook wrapper all SQLite drivers share.
```

- [ ] **Step 7: Verify and commit**

Run:
1. `pnpm --filter @statewalker/db-tests test && pnpm --filter @statewalker/consumer-install-tests test`
2. `pnpm typecheck`
3. `pnpm biome check --write --unsafe`

Expected: all green.

```bash
git add packages/db-sqlite packages/db-tests tools/consumer-install .changeset/db-sqlite-transactions.md pnpm-lock.yaml
git commit -m "feat(db-sqlite): inTransaction and the serialised SQLite engine wrapper, with shared transaction scenarios"
```

---

### Task 2: `db-sqlite-node` on `node:sqlite`

**Files:**
- Modify: `packages/db-sqlite-node/src/node-sqlite-db.ts`, `packages/db-sqlite-node/src/node-sqlite-db.test.ts`, `packages/db-sqlite-node/package.json`, `packages/db-sqlite-node/README.md`
- Modify: `pnpm-workspace.yaml` (remove `'@libsql/client'`)
- Create: `.changeset/db-sqlite-node-node-sqlite.md`

**Interfaces:**
- **Consumes:** `newSerialisedSqliteDb`, `SqliteEngine` (Task 1); `runDbConformance`, `runSqliteTransactionConformance` (Task 1).
- **Produces:** `newNodeSqliteDb(options?: DbOptions): Promise<Db>`. The signature is unchanged, and the returned Db carries the transaction hook.

- [ ] **Step 1: Write the failing tests**

Replace the libSQL-specific parts of `packages/db-sqlite-node/src/node-sqlite-db.test.ts`:
1. Delete the whole `describe("vector search", ...)` block. It tests libSQL-only functions (`vector32`, `libsql_vector_idx`, `vector_top_k`).
2. Replace the header comment and the conformance call with:

```ts
import type { Db } from "@statewalker/db-api";
import { runDbConformance, runSqliteTransactionConformance } from "@statewalker/db-tests";
import { afterEach, describe, expect, it } from "vitest";
import { newNodeSqliteDb } from "./node-sqlite-db.js";

// Common contract and SQLite transactions come from the shared suites; FTS5 stays here.
runDbConformance(newNodeSqliteDb, { placeholder: "?" });
runSqliteTransactionConformance(() => newNodeSqliteDb());
```

3. Inside `describe("FTS5", ...)` add:

```ts
    it("has the trigram tokenizer (substring search)", async () => {
      db = await newNodeSqliteDb();
      await db.exec("CREATE VIRTUAL TABLE g USING fts5(c, tokenize='trigram')");
      await db.exec("INSERT INTO g VALUES ('idx_lefthand')");
      const rows = await db.query<{ c: string }>("SELECT c FROM g WHERE g MATCH 'x_le'");
      expect(rows.map((r) => r.c)).toEqual(["idx_lefthand"]);
    });
```

4. Change the `describe("newNodeSqliteDb", ...)` header comment to `// Engine-specific behaviour kept per driver: FTS5 with the default, porter and trigram tokenizers.`

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @statewalker/db-sqlite-node test`
Expected: FAIL. Every "SQLite transaction conformance" test rejects with `inTransaction: this Db has no SQLite transaction hook`, because the libSQL Db has no hook.

- [ ] **Step 3: Implement**

`packages/db-sqlite-node/src/node-sqlite-db.ts`:

```ts
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db, DbOptions } from "@statewalker/db-api";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";

/**
 * Create a SQLite {@link Db} on Node.js's built-in `node:sqlite`.
 *
 * @param options.path  Database file. Omit for an in-memory database.
 */
export async function newNodeSqliteDb(options?: DbOptions): Promise<Db> {
  const db = new DatabaseSync(options?.path ?? ":memory:");
  return newSerialisedSqliteDb({
    all: (sql, params) => db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[],
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
}
```

`packages/db-sqlite-node/package.json`:
- `"description": "SQLite driver for @statewalker/db-api on Node.js's built-in node:sqlite, with transactions through @statewalker/db-sqlite."`;
- in `dependencies`, replace `"@libsql/client": "catalog:"` with `"@statewalker/db-sqlite": "workspace:^"`.

`pnpm-workspace.yaml`: delete the line `'@libsql/client': ^0.18.0`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm install && pnpm --filter @statewalker/db-sqlite-node test`
Expected: PASS. That is 10 "Db conformance", 12 "SQLite transaction conformance" and 4 FTS5 tests.

- [ ] **Step 5: README and changeset**

`packages/db-sqlite-node/README.md`: replace these sections.

"## What it is":

```markdown
A SQLite driver for Node.js that implements `Db` from `@statewalker/db-api` on Node.js's
built-in `node:sqlite` (SQLite 3.53 in Node.js 24), with a local file or an in-memory database.
Its Db works with `inTransaction` from `@statewalker/db-sqlite`. FTS5 is included, with the
`unicode61`, `porter` and `trigram` tokenizers.
```

"## Why it exists": keep the paragraph, then add: "It needs no native addon or extra download, since the engine ships with Node.js."

In "## How to use", replace the paragraph after the table with:

```markdown
`newNodeSqliteDb(options?)` returns `Promise<Db>`. It opens `path`, or `:memory:` without one.
The `Db` implements `query`, `exec` and `close`; it has no `flush` (every commit is on disk).
Use `?` placeholders. Wrap related writes in `inTransaction(db, async (tx) => ...)` from
`@statewalker/db-sqlite`.
```

"## Internals":

```markdown
- **Calls are queued.** The Db runs one call at a time in call order, and opens transactions
  with `BEGIN IMMEDIATE` (see `@statewalker/db-sqlite`). `node:sqlite` is synchronous, so a long
  statement blocks the event loop while it runs.
- **`query` runs one statement.** Anything after the first `;` is ignored without an error;
  use `exec` for multi-statement scripts.
- **Rows are plain objects with a `null` prototype**, BLOBs are `Uint8Array`, integers are
  JavaScript numbers: values above 2^53 lose precision.
- **Errors are `node:sqlite`'s.** A path in a missing directory rejects with
  `unable to open database file`; bad SQL rejects with `near "...": syntax error`; a call after
  `close()` rejects with `db-sqlite: the database is closed`.
- **Node.js prints `ExperimentalWarning: SQLite is an experimental feature`** on first use in
  the Node.js versions that still mark `node:sqlite` experimental. It is harmless.
- **Dependencies:** `@statewalker/db-sqlite` (queue and transactions), `@statewalker/db-api`
  (types). The engine is part of Node.js.
```

`.changeset/db-sqlite-node-node-sqlite.md`:

```markdown
---
"@statewalker/db-sqlite-node": minor
---

Breaking: the engine is now Node.js's built-in `node:sqlite` instead of `@libsql/client`. libSQL vector functions (`vector32`, `libsql_vector_idx`, `vector_top_k`) are gone; rows are plain objects; the Db supports `inTransaction` from `@statewalker/db-sqlite`.
```

- [ ] **Step 6: Verify and commit**

Run:
1. `pnpm --filter @statewalker/db-sqlite-node test && pnpm --filter @statewalker/consumer-install-tests test`
2. `pnpm typecheck`
3. `pnpm biome check --write --unsafe`

```bash
git add packages/db-sqlite-node pnpm-workspace.yaml pnpm-lock.yaml .changeset/db-sqlite-node-node-sqlite.md
git commit -m "feat(db-sqlite-node)!: run on node:sqlite with SQLite transactions"
```

---

### Task 3: `@statewalker/db-sqlite-do` and the fake DO storage

**Fake placement, decided:** the fake is published as the Node-only subpath **`@statewalker/db-sqlite-do/fake`**. It is not put in `db-tests`.
- `db-tests` is private and never reaches npm.
- The engines in other repositories (vector and n-gram in P2/P3, `webrun-files-sqlite` in P4, `indexer-sqlite` in P5) must also run "on every commit" against the DO limits (D14), so they need the fake from npm.
- A separate subpath keeps `node:sqlite` out of a worker bundle that imports `"."`.

**Files:**
- Create: `packages/db-sqlite-do/package.json`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts`, `README.md`
- Create: `packages/db-sqlite-do/src/index.ts`, `src/do-sqlite-db.ts`, `src/fake.ts`, `src/fake-do-storage.ts`, `src/do-sqlite-db.test.ts`
- Create: `packages/db-sqlite-do/test-do/platform-probe.ts`
- Modify: `tools/consumer-install/consumer-install.test.ts`
- Create: `.changeset/db-sqlite-do.md`

**Interfaces:**
- **Consumes:** `newSerialisedSqliteDb` (Task 1); `runDbConformance`, `runSqliteTransactionConformance` (Task 1).
- **Produces:**
  ```ts
  // @statewalker/db-sqlite-do
  export interface DoSqlCursor { toArray(): Record<string, unknown>[] }
  export interface DoSqlStorage {
    sql: { exec(query: string, ...bindings: unknown[]): DoSqlCursor };
    transaction<T>(closure: () => Promise<T>): Promise<T>;
  }
  export function newDoSqliteDb(storage: DoSqlStorage): Db;
  // @statewalker/db-sqlite-do/fake   (Node.js only)
  export type FakeDoStorage = DoSqlStorage & { close(): void };
  export function newFakeDoStorage(): FakeDoStorage;
  // test-do/platform-probe.ts (used by Task 4)
  export function probeDoSqlite(storage: DoSqlStorage): Record<string, string>;
  export const PROBE_EXPECTATIONS: Record<string, "ok" | RegExp>;
  ```
  `newDoSqliteDb` returns a `Db` synchronously; it isn't a Promise, because a DO constructor cannot await. `close()` releases nothing (the storage belongs to the DO), but it marks the Db closed so later calls reject, as `runDbConformance` requires. **This refines D3's "close does nothing".**

- [ ] **Step 1: Scaffold the package**

`packages/db-sqlite-do/package.json`. It has the same fields as `db-sqlite`'s; the differences are below.

```json
{
  "name": "@statewalker/db-sqlite-do",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "description": "Durable Object SQLite (ctx.storage) driver for @statewalker/db-api, with transactions through @statewalker/db-sqlite and a node:sqlite fake for tests.",
  "bugs": { "url": "https://github.com/statewalker/statewalker-db/issues" },
  "homepage": "https://github.com/statewalker/statewalker-db/tree/main/packages/db-sqlite-do#readme",
  "author": { "name": "Mikhail Kotelnikov", "email": "mikhail.kotelnikov@gmail.com" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/statewalker/statewalker-db.git",
    "directory": "packages/db-sqlite-do"
  },
  "exports": {
    ".": { "source": "./src/index.ts", "types": "./dist/index.d.mts", "import": "./dist/index.mjs" },
    "./fake": { "source": "./src/fake.ts", "types": "./dist/fake.d.mts", "import": "./dist/fake.mjs" }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsdown",
    "prepack": "pnpm run build",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "test:do": "vitest run --config vitest.do.config.ts",
    "typecheck": "tsc --noEmit",
    "clean": "rimraf dist",
    "lint": "biome check --write .",
    "format": "biome format --write ."
  },
  "dependencies": {
    "@statewalker/db-api": "workspace:^",
    "@statewalker/db-sqlite": "workspace:^"
  },
  "devDependencies": {
    "@statewalker/db-tests": "workspace:^",
    "@types/node": "catalog:",
    "rimraf": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "sideEffects": false,
  "publishConfig": { "access": "public" }
}
```

`packages/db-sqlite-do/tsconfig.json`: copy `packages/db-sqlite-node/tsconfig.json`.

`packages/db-sqlite-do/tsdown.config.ts`:

```ts
import { defineConfig } from "tsdown";

export default defineConfig({ entry: ["src/index.ts", "src/fake.ts"] });
```

`packages/db-sqlite-do/vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from "vitest/config";

/** Unit tests on the node:sqlite fake. The real-celld suite in test-do/ runs only through `test:do`. */
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "test-do/**"] },
});
```

- [ ] **Step 2: Write the platform probe**

`packages/db-sqlite-do/test-do/platform-probe.ts`. It is vitest-free, because Task 4 bundles it into the worker. It records the DO SQLite behaviour the drivers and engines rely on.

```ts
import type { DoSqlStorage } from "../src/index.js";

/** What every probe must give: "ok", or an error whose text matches the pattern. */
export const PROBE_EXPECTATIONS: Record<string, "ok" | RegExp> = {
  begin: /not authorized/,
  savepoint: /not authorized/,
  pragma: /not authorized/,
  fts5Trigram: "ok",
  fts5PorterUnicode61: "ok",
  jsonEach: "ok",
  multiStatementExec: "ok",
  params100: "ok",
  params200: /too many SQL variables/,
  blob1900k: "ok",
  blob2500k: /too big/,
  blobReadsAsArrayBuffer: "ok",
};

/** Run each probe against fresh tables of `storage`; each result is "ok" or "error: <message>". */
export function probeDoSqlite(storage: DoSqlStorage): Record<string, string> {
  const run = (query: string, ...bindings: unknown[]) => storage.sql.exec(query, ...bindings).toArray();
  const out: Record<string, string> = {};
  const probe = (name: string, fn: () => void) => {
    try {
      fn();
      out[name] = "ok";
    } catch (error) {
      out[name] = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const expectRows = (rows: unknown[], n: number) => {
    if (rows.length !== n) throw new Error(`expected ${n} rows, got ${rows.length}`);
  };
  const params = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  run("CREATE TABLE probe_b (k INTEGER PRIMARY KEY, d BLOB)");
  probe("begin", () => run("BEGIN"));
  probe("savepoint", () => run("SAVEPOINT s"));
  probe("pragma", () => run("PRAGMA compile_options"));
  probe("fts5Trigram", () => {
    run("CREATE VIRTUAL TABLE probe_g USING fts5(c, tokenize='trigram')");
    run("INSERT INTO probe_g VALUES ('idx_lefthand')");
    expectRows(run("SELECT c FROM probe_g WHERE probe_g MATCH 'x_le'"), 1);
  });
  probe("fts5PorterUnicode61", () => {
    run("CREATE VIRTUAL TABLE probe_p USING fts5(c, tokenize='porter unicode61 remove_diacritics 2')");
    run("INSERT INTO probe_p VALUES ('Running cafés')");
    expectRows(run("SELECT c FROM probe_p WHERE probe_p MATCH 'run AND cafe'"), 1);
  });
  probe("jsonEach", () => expectRows(run("SELECT value FROM json_each(?)", "[1,2,3]"), 3));
  probe("multiStatementExec", () => {
    run("CREATE TABLE probe_m1 (a INTEGER); CREATE TABLE probe_m2 (a INTEGER)");
    run("INSERT INTO probe_m2 VALUES (1)");
  });
  probe("params100", () => run(`SELECT 1 WHERE 1 IN (${params(100).fill(0).map(() => "?").join(",")})`, ...params(100)));
  probe("params200", () => run(`SELECT 1 WHERE 1 IN (${params(200).fill(0).map(() => "?").join(",")})`, ...params(200)));
  probe("blob1900k", () => run("INSERT INTO probe_b VALUES (1, ?)", new ArrayBuffer(1_900_000)));
  probe("blob2500k", () => run("INSERT INTO probe_b VALUES (2, ?)", new ArrayBuffer(2_500_000)));
  probe("blobReadsAsArrayBuffer", () => {
    const value = run("SELECT d FROM probe_b WHERE k = 1")[0]?.d;
    if (!(value instanceof ArrayBuffer)) {
      throw new Error(`read back ${Object.prototype.toString.call(value)}`);
    }
  });
  return out;
}
```

- [ ] **Step 3: Write the failing tests**

`packages/db-sqlite-do/src/do-sqlite-db.test.ts`:

```ts
import { runDbConformance, runSqliteTransactionConformance } from "@statewalker/db-tests";
import { describe, expect, it } from "vitest";
import { PROBE_EXPECTATIONS, probeDoSqlite } from "../test-do/platform-probe.js";
import { newDoSqliteDb } from "./do-sqlite-db.js";
import { newFakeDoStorage } from "./fake-do-storage.js";

// Same suites as every other SQLite driver, on the node:sqlite fake of ctx.storage.
runDbConformance(async () => newDoSqliteDb(newFakeDoStorage()), {
  placeholder: "?",
  skipFilePersistence: true,
});
runSqliteTransactionConformance(async () => newDoSqliteDb(newFakeDoStorage()));

describe("newFakeDoStorage", () => {
  // The same probe runs on real DO SQLite in `test:do`; both must meet the same expectations.
  it("matches the probed Durable Object SQLite behaviour", () => {
    const storage = newFakeDoStorage();
    try {
      const result = probeDoSqlite(storage);
      for (const [name, want] of Object.entries(PROBE_EXPECTATIONS)) {
        if (want === "ok") expect(result[name], name).toBe("ok");
        else expect(result[name], name).toMatch(want);
      }
    } finally {
      storage.close();
    }
  });

  it("rejects a typed array bound as a BLOB, as the driver must pass an ArrayBuffer", () => {
    const storage = newFakeDoStorage();
    try {
      storage.sql.exec("CREATE TABLE b (d BLOB)");
      expect(() => storage.sql.exec("INSERT INTO b VALUES (?)", new Uint8Array([1]))).toThrow(/ArrayBuffer/);
    } finally {
      storage.close();
    }
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `pnpm install && pnpm --filter @statewalker/db-sqlite-do test`
Expected: FAIL with "Cannot find module './do-sqlite-db.js'".

- [ ] **Step 5: Implement**

`packages/db-sqlite-do/src/do-sqlite-db.ts`:

```ts
import type { Db } from "@statewalker/db-api";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";

/** The rows of one `ctx.storage.sql.exec` call. */
export interface DoSqlCursor {
  toArray(): Record<string, unknown>[];
}

/** The part of a Durable Object's `ctx.storage` this driver uses; `ctx.storage` fits it as is. */
export interface DoSqlStorage {
  sql: { exec(query: string, ...bindings: unknown[]): DoSqlCursor };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

/** DO SQLite binds BLOBs from ArrayBuffer; copy exactly the view's bytes. */
const toDoValue = (value: unknown): unknown =>
  ArrayBuffer.isView(value)
    ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    : value;

/** DO SQLite reads BLOBs back as ArrayBuffer; every SQLite Db returns Uint8Array. */
const fromDoRow = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    ]),
  );

/**
 * A {@link Db} over a Durable Object's SQLite storage (`ctx.storage`). Transactions go through
 * `storage.transaction`, since DO SQLite rejects `BEGIN`. Create one per DO, in its constructor.
 */
export function newDoSqliteDb(storage: DoSqlStorage): Db {
  return newSerialisedSqliteDb({
    all: (sql, params) => storage.sql.exec(sql, ...params.map(toDoValue)).toArray().map(fromDoRow),
    exec: (sql) => {
      storage.sql.exec(sql).toArray();
    },
    close: () => {},
    transaction: (fn) => storage.transaction(fn),
  });
}
```

`packages/db-sqlite-do/src/fake-do-storage.ts`:

```ts
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DoSqlStorage } from "./do-sqlite-db.js";

export type FakeDoStorage = DoSqlStorage & { close(): void };

/** Limits probed on celld's DO SQLite (see test-do/platform-probe.ts). */
const MAX_BOUND_PARAMETERS = 100;
const MAX_BLOB_BYTES = 2_000_000;
const NOT_AUTHORIZED = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/i;

/**
 * An in-memory stand-in for a Durable Object's `ctx.storage` on Node.js's `node:sqlite`, with the
 * DO limits: no SQL-level transactions or PRAGMA, at most 100 bound parameters, BLOBs bound and
 * read as ArrayBuffer and at most ~2 MB. `transaction` runs the closure between BEGIN and
 * COMMIT/ROLLBACK and, like the platform, does not queue concurrent calls.
 */
export function newFakeDoStorage(): FakeDoStorage {
  const db = new DatabaseSync(":memory:");
  const bind = (value: unknown): SQLInputValue => {
    if (ArrayBuffer.isView(value)) {
      throw new TypeError("fake DO storage: bind a BLOB as an ArrayBuffer, not a typed array");
    }
    if (value instanceof ArrayBuffer) {
      if (value.byteLength > MAX_BLOB_BYTES) {
        throw new Error("SQL error: bind sync KV cursor: string or blob too big");
      }
      return new Uint8Array(value);
    }
    return value as SQLInputValue;
  };
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        if (NOT_AUTHORIZED.test(query)) throw new Error("SQL error: prepare SQL cursor: not authorized");
        if (bindings.length > MAX_BOUND_PARAMETERS) {
          throw new Error("SQL error: prepare SQL cursor: too many SQL variables");
        }
        const statement = db.prepare(query);
        let rows: Record<string, unknown>[] = [];
        // prepare() compiles only the first statement: run row-less, parameter-less text with exec().
        if (bindings.length === 0 && statement.columns().length === 0) db.exec(query);
        else rows = statement.all(...bindings.map(bind)) as Record<string, unknown>[];
        const out = rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array ? value.slice().buffer : value,
            ]),
          ),
        );
        return { toArray: () => out };
      },
    },
    async transaction<T>(closure: () => Promise<T>): Promise<T> {
      db.exec("BEGIN");
      try {
        const result = await closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
```

`packages/db-sqlite-do/src/index.ts`:

```ts
export type { Db, DbEntry } from "@statewalker/db-api";
export { type DoSqlCursor, type DoSqlStorage, newDoSqliteDb } from "./do-sqlite-db.js";
```

`packages/db-sqlite-do/src/fake.ts`:

```ts
export { type FakeDoStorage, newFakeDoStorage } from "./fake-do-storage.js";
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `pnpm --filter @statewalker/db-sqlite-do test`
Expected: PASS. That is 10 Db conformance tests (file persistence skipped), 12 transaction conformance tests and 2 fake tests.

- [ ] **Step 7: README, consumer-install, changeset**

`packages/db-sqlite-do/README.md`:

````markdown
# @statewalker/db-sqlite-do

## What it is

A driver that implements `Db` from `@statewalker/db-api` on a Durable Object's SQLite storage
(`ctx.storage`), on Cloudflare or on celld. Its Db works with `inTransaction` from
`@statewalker/db-sqlite`. The `./fake` subpath gives a Node.js stand-in for `ctx.storage` with
the same limits, for unit tests.

## Why it exists

Code written against `Db` (search indexes, file stores) must run inside a Durable Object as it
does on Node.js and in the browser. DO SQLite differs in ways that break such code silently: SQL
`BEGIN` is rejected, `transactionSync` commits at the first `await`, BLOBs come back as
`ArrayBuffer`. This driver hides those differences behind the same `Db` and transaction call.

## How to use

```sh
pnpm add @statewalker/db-sqlite-do
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-do` | `newDoSqliteDb`; types `DoSqlStorage`, `DoSqlCursor` | Durable Object (Cloudflare, celld) |
| `@statewalker/db-sqlite-do/fake` | `newFakeDoStorage` | Node.js (tests) |

`newDoSqliteDb(storage)` returns a `Db` synchronously, so it can be created in the DO
constructor. Use `?` placeholders.

## Examples

```ts
import { DurableObject } from "cloudflare:workers";
import { inTransaction } from "@statewalker/db-sqlite";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";

export class Notes extends DurableObject {
  db = newDoSqliteDb(this.ctx.storage);

  async add(body: string) {
    await this.db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
    return inTransaction(this.db, (tx) =>
      tx.query<{ id: number }>("INSERT INTO notes (body) VALUES (?) RETURNING id", [body]),
    );
  }
}
```

In a Node.js test:

```ts
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";

const db = newDoSqliteDb(newFakeDoStorage());
```

## Internals

- **Transactions use `storage.transaction(async fn)`.** It rolls back on a throw even after
  `await`s on timers or `fetch`. `transactionSync` is not used: given an async function it commits
  at the first `await`, so a later throw rolls nothing back. The platform may run the callback
  again, so it must be idempotent and do no external I/O.
- **Limits of DO SQLite, and what they look like:** more than 100 bound parameters rejects with
  `too many SQL variables` (pass id lists as one JSON string to `json_each(?)`); a BLOB or string
  over about 2 MB rejects with `string or blob too big`; `BEGIN`, `SAVEPOINT` and `PRAGMA` reject
  with `not authorized`. An operation that runs past the platform deadline (15 s on celld) is
  retried rather than failed, so keep each write step small.
- **BLOBs are converted both ways.** Typed-array parameters are bound as `ArrayBuffer`;
  `ArrayBuffer` values read back become `Uint8Array`, as on every other SQLite driver.
- **`close()` releases nothing.** The storage belongs to the DO. It only makes later calls on this
  Db reject with `db-sqlite: the database is closed`.
- **Use one Db per DO.** Calls are queued inside one Db; direct `ctx.storage.sql` calls made
  elsewhere in the DO bypass that queue.
- **The fake is strict where the platform is unknown.** It rejects every `PRAGMA` (the platform
  allows a few) and typed-array BLOB parameters, so code that passes on the fake does not depend
  on them. Its limits are checked against real DO SQLite by `pnpm test:do`, which runs the same
  probe in a `celld dev` Durable Object.
- **Dependencies:** `@statewalker/db-sqlite` (queue and transactions), `@statewalker/db-api`
  (types). `./fake` uses Node.js's `node:sqlite`.

## License

MIT
````

`tools/consumer-install/consumer-install.test.ts`: add `{ name: "@statewalker/db-sqlite-do", dir: "db-sqlite-do", subpaths: [".", "./fake"] },`.

`.changeset/db-sqlite-do.md`:

```markdown
---
"@statewalker/db-sqlite-do": minor
---

New package: `newDoSqliteDb(ctx.storage)`, a Db on Durable Object SQLite with `inTransaction` support, and `@statewalker/db-sqlite-do/fake`, a node:sqlite stand-in with the DO limits.
```

- [ ] **Step 8: Verify and commit**

Run:
1. `pnpm --filter @statewalker/db-sqlite-do test && pnpm --filter @statewalker/consumer-install-tests test`
2. `pnpm typecheck`
3. `pnpm biome check --write --unsafe`

```bash
git add packages/db-sqlite-do tools/consumer-install .changeset/db-sqlite-do.md pnpm-lock.yaml
git commit -m "feat(db-sqlite-do): Durable Object SQLite driver and node:sqlite fake with the DO limits"
```

---

### Task 4 (P0): celld 0.6.x and the real-DO `test:do` harness

**Files:**
- Create: `packages/db-sqlite-do/vitest.do.config.ts`, `packages/db-sqlite-do/test-do/wrangler.jsonc`, `test-do/worker.ts`, `test-do/scenarios.ts`, `test-do/global-setup.ts`, `test-do/do-conformance.do.test.ts`
- Modify: `package.json` (root script `test:do`), `.gitignore` (`.celld/`), `packages/db-sqlite-do/README.md`, `README.md`
- Modify: the grill note `~/workspace-statewalker/notes/2026/2026-10/2026-10-17/grill-sqlite-db-indexing.md` (section "Still unknown (W2)", first bullet)

**Interfaces:**
- **Consumes:**
  - `newDoSqliteDb` and `probeDoSqlite`/`PROBE_EXPECTATIONS` (Task 3);
  - `sqliteTransactionScenarios` from `@statewalker/db-tests/sqlite-transaction-scenarios` and `runDbConformance` (Task 1).
- **Produces:**
  - `pnpm test:do` at the root;
  - the HTTP routes of the conformance worker: `POST /db/<id>` with `{op, sql?, params?}`, `POST /scenario/<id>/<name>`, `POST /probe/<id>`;
  - **`test-do/scenarios.ts`, the one list of scenarios run inside a real DO.** Other packages of this repository (P2 vector, P3 n-gram) add their smoke scenarios there by **relative import** of a file in their own `src/` (for example `../../db-sqlite-index/src/vector/do-smoke.ts`). A relative import, not a package dependency, because `db-sqlite-index` already dev-depends on `db-sqlite-do` and a dependency back would be a workspace cycle. Every scenario has the shape `{ name: string; run(db: Db): Promise<void> }` (`SqliteTransactionScenario`), and names are unique (`vector: …`, `ngram: …`).

P0 sits after Task 3 because the harness runs the DO driver. The celld upgrade in Step 1 can be done at any time.

- [ ] **Step 1: Upgrade celld to 0.6.x**

celld 0.5.1 came from the official installer (`~/.local/bin/celld -> ../lib/celld/releases/v0.5.1/celld`).

Run:
1. `S=$(mktemp -d) && curl -fsSL https://celld.dev/install.sh -o "$S/install.sh" && less "$S/install.sh"`. Read it before running it. Note whether it takes a version (an env var or an argument), and pin `0.6.x` if it does.
2. `sh "$S/install.sh"`
3. `celld --version`

Expected: `celld 0.6.<n>`, and `~/.local/bin/celld` points into `~/.local/lib/celld/releases/v0.6.<n>/`.

- **Way back:** `ln -sfn ../lib/celld/releases/v0.5.1/celld ~/.local/bin/celld`.
- A `celld dev` the user already has running keeps its old binary. Do not stop it.

- [ ] **Step 2: Write the worker and the real-DO test (the failing test)**

`packages/db-sqlite-do/test-do/wrangler.jsonc`:

```jsonc
{
  "name": "db-sqlite-do-conformance",
  "main": "worker.ts",
  "compatibility_date": "2026-10-01",
  "durable_objects": { "bindings": [{ "name": "CONFORMANCE", "class_name": "ConformanceDo" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ConformanceDo"] }]
}
```

`packages/db-sqlite-do/test-do/worker.ts`. celld bundles it with esbuild. It is outside `tsconfig`'s `src` include because `cloudflare:workers` has no types here.

`packages/db-sqlite-do/test-do/scenarios.ts`:

```ts
import { sqliteTransactionScenarios } from "@statewalker/db-tests/sqlite-transaction-scenarios";

/**
 * Every scenario the real-DO suite runs. Other packages of this repository append their smoke
 * scenarios here by relative import of a file in their own src/ (no package dependency: that
 * would be a workspace cycle). Names must be unique.
 */
export const SCENARIOS = [...sqliteTransactionScenarios];
```

```ts
import { DurableObject } from "cloudflare:workers";
import { newDoSqliteDb } from "../src/index.js";
import { probeDoSqlite } from "./platform-probe.js";
import { SCENARIOS } from "./scenarios.js";

type Op = { op: "query" | "exec" | "close"; sql?: string; params?: unknown[] };
type Reply = Record<string, unknown>;
type Stub = { op(op: Op): Promise<Reply>; scenario(name: string): Promise<Reply>; probe(): Promise<Reply> };
type Env = { CONFORMANCE: { idFromName(name: string): unknown; get(id: unknown): Stub } };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One DO per test id: the Db conformance ops, the transaction scenarios and the platform probe. */
export class ConformanceDo extends DurableObject {
  db = newDoSqliteDb(this.ctx.storage);

  async op({ op, sql = "", params }: Op): Promise<Reply> {
    try {
      if (op === "query") return { rows: await this.db.query(sql, params) };
      if (op === "exec") await this.db.exec(sql);
      else await this.db.close();
      return {};
    } catch (error) {
      return { error: errorText(error) };
    }
  }

  async scenario(name: string): Promise<Reply> {
    const scenario = SCENARIOS.find((s) => s.name === name);
    if (!scenario) return { error: `unknown scenario: ${name}` };
    try {
      await scenario.run(this.db);
      return { ok: true };
    } catch (error) {
      return { error: errorText(error) };
    }
  }

  async probe(): Promise<Reply> {
    return probeDoSqlite(this.ctx.storage);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, kind, id = "default", name = ""] = new URL(request.url).pathname.split("/");
    const stub = env.CONFORMANCE.get(env.CONFORMANCE.idFromName(id));
    if (kind === "db") return Response.json(await stub.op(await request.json()));
    if (kind === "scenario") return Response.json(await stub.scenario(decodeURIComponent(name)));
    if (kind === "probe") return Response.json(await stub.probe());
    return new Response("not found", { status: 404 });
  },
};
```

`packages/db-sqlite-do/test-do/global-setup.ts`:

```ts
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    doBaseUrl: string;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no free port")),
      );
    });
  });

/** Start `celld dev` on test-do/ with a clean state; stop exactly that process afterwards. */
export default async function setup(project: TestProject) {
  const version = execFileSync("celld", ["--version"], { encoding: "utf8" }).trim();
  if (!/^celld 0\.6\./.test(version)) {
    throw new Error(`test:do needs celld 0.6.x on PATH, found "${version}" (curl -fsSL https://celld.dev/install.sh | sh)`);
  }
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const port = await freePort();
  const child = spawn("celld", ["dev", dir, "--port", String(port), "--clean", "--no-watch"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`celld dev was not ready within 60 s:\n${log}`)), 60_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      const ready = /ready\s+(http:\/\/[^\s\u001b]+)/.exec(log);
      if (ready?.[1]) {
        clearTimeout(timer);
        resolve(ready[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`celld dev exited (${code}) before it was ready:\n${log}`));
    });
  });
  project.provide("doBaseUrl", baseUrl);
  return () => {
    child.kill("SIGTERM");
  };
}
```

`packages/db-sqlite-do/test-do/do-conformance.do.test.ts`:

```ts
import type { Db, DbEntry } from "@statewalker/db-api";
import { runDbConformance } from "@statewalker/db-tests";
import { describe, expect, inject, it } from "vitest";
import { PROBE_EXPECTATIONS } from "./platform-probe.js";
import { SCENARIOS } from "./scenarios.js";

const base = inject("doBaseUrl");

async function post(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** A Db whose every call runs on newDoSqliteDb inside the DO named `id`. */
function remoteDb(id: string): Db {
  const call = async (op: string, sql?: string, params?: unknown[]) => {
    const reply = await post(`/db/${id}`, { op, sql, params });
    if (typeof reply.error === "string") throw new Error(reply.error);
    return reply;
  };
  return {
    query: async <T = DbEntry>(sql: string, params?: unknown[]) => (await call("query", sql, params)).rows as T[],
    exec: async (sql: string) => {
      await call("exec", sql);
    },
    close: async () => {
      await call("close");
    },
  };
}

runDbConformance(async () => remoteDb(crypto.randomUUID()), {
  placeholder: "?",
  skipFilePersistence: true,
});

describe("scenarios on celld (transactions + registered smoke scenarios)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      expect(await post(`/scenario/${crypto.randomUUID()}/${encodeURIComponent(scenario.name)}`)).toEqual({ ok: true });
    });
  }
});

describe("celld DO SQLite", () => {
  it("behaves as the fake assumes", async () => {
    const result = await post(`/probe/${crypto.randomUUID()}`);
    for (const [name, want] of Object.entries(PROBE_EXPECTATIONS)) {
      if (want === "ok") expect(result[name], name).toBe("ok");
      else expect(result[name], name).toMatch(want);
    }
  });
});
```

`packages/db-sqlite-do/vitest.do.config.ts`:

```ts
import { defineConfig } from "vitest/config";

/** The real Durable Object suite: needs celld 0.6.x on PATH and built workspace packages. */
export default defineConfig({
  test: {
    include: ["test-do/**/*.do.test.ts"],
    globalSetup: ["test-do/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
```

Root `package.json` scripts: add `"test:do": "pnpm -r run build && pnpm --filter @statewalker/db-sqlite-do test:do"`. The build is needed because esbuild resolves `@statewalker/db-sqlite` through its `import` condition, which points to `dist/`.

`.gitignore`: add `.celld/`.

- [ ] **Step 3: Run it and see the probe result**

Run: `pnpm test:do`

Expected:
- With celld 0.5.1 still on `PATH`, global setup fails with `test:do needs celld 0.6.x on PATH, found "celld 0.5.1"`.
- With 0.6.x: 10 + 12 + 1 tests. A failure here is information about 0.6.x, not a harness bug. Handle it this way:
  - **A probe mismatch** means the platform changed. Update `PROBE_EXPECTATIONS` **and** the fake's constants and regex in `src/fake-do-storage.ts` together, so the unit test in Task 3 stays green, and note the change in the README.
  - **A scenario failure** is a driver defect. Fix `src/do-sqlite-db.ts` (for example: if `multiStatementExec` fails, `exec` has to split statements).

  Iterate until it is green.

- [ ] **Step 4: Record the probe result**

In the grill note's "## Still unknown (W2)", replace the first bullet with one line:
- `celld 0.6.<n> probed on <date>: <"same limits as 0.5.1" or the differences>; pinned by db-sqlite-do test:do.`

- [ ] **Step 5: README updates**

`packages/db-sqlite-do/README.md`: add this section before "## Internals":

```markdown
## How it is tested against a real Durable Object

`pnpm test:do` (from the repository root) builds the workspace, starts `celld dev` on
`packages/db-sqlite-do/test-do/` with a clean state on a free port, and runs, inside a real
Durable Object, the shared `Db` conformance suite (through a small HTTP bridge), every scenario
listed in `test-do/scenarios.ts` (the SQLite transaction scenarios plus the smoke scenarios other
packages register there), and a platform probe whose expectations the `./fake` must also meet. It
needs celld 0.6.x on `PATH`; with another version it stops at once with
`test:do needs celld 0.6.x on PATH, found "<version>"`. It stops only the celld process it
started. It is not part of `pnpm test`: run it before a release.
```

Root `README.md`:
- in "## How to run it", after step 4, add: `5. Optional, the Durable Object driver on a real celld: \`pnpm run test:do\` (needs celld 0.6.x on PATH).` Renumber the old step 5 to 6.
- in "## What will surprise you", add: `- **\`pnpm run test:do\` starts a celld node.** It runs \`celld dev\` on a free port with \`--clean\` on \`packages/db-sqlite-do/test-do/.celld/dev\` and stops it at the end; a version other than 0.6.x stops it before any test.`

- [ ] **Step 6: Verify and commit**

Run:
1. `pnpm test:do && pnpm --filter @statewalker/db-sqlite-do test`
2. `pnpm typecheck`
3. `pnpm biome check --write --unsafe`

Expected: all green.

```bash
git add packages/db-sqlite-do package.json .gitignore README.md
git commit -m "test(db-sqlite-do): real Durable Object suite on celld 0.6 (test:do)"
```

The notes change goes in the notes repository with its own commit (`git -C ~/workspace-statewalker/notes ...`). Commit only that file; the notes checkout has unrelated uncommitted work.

---

### Task 5: `db-sqlite-browser` on `@sqlite.org/sqlite-wasm`

**Files:**
- Modify: `packages/db-sqlite-browser/src/browser-sqlite-db.ts`, `src/browser-sqlite-db.test.ts`, `src/browser-sqlite-db.browser.test.ts`, `vitest.browser.config.ts`, `vitest.config.ts` (comment only), `package.json`, `README.md`
- Create: `packages/db-sqlite-browser/test/opfs-test-worker.ts`
- Modify: `pnpm-workspace.yaml` (remove `'@libsql/libsql-wasm-experimental'`), root `package.json` (description), root `README.md`, `packages/db-tests/README.md` (libSQL mentions), `packages/db-tests/src/suites/db-conformance.suite.ts` (comments that name libsql)
- Create: `.changeset/db-sqlite-browser-sqlite-wasm.md`

**Interfaces:**
- **Consumes:** `newSerialisedSqliteDb` (Task 1); both conformance suites.
- **Produces:**
  - `newBrowserSqliteDb(options?: BrowserDbOptions): Promise<Db>`, with `BrowserDbOptions = DbOptions & { wasmUrl?: string }`. Same names.
  - The `wasmUrl` default changes from `"/sqlite3.wasm"` to the package's own `sqlite3.wasm`, resolved by the bundler.
  - A `path` is allowed only in a Dedicated Worker.

- [ ] **Step 1: Write the failing tests**

`packages/db-sqlite-browser/src/browser-sqlite-db.test.ts`. This is the Node side; `@sqlite.org/sqlite-wasm` resolves to its `node` build, in memory.

```ts
import { createRequire } from "node:module";
import { runDbConformance, runSqliteTransactionConformance } from "@statewalker/db-tests";
import { describe, expect, it } from "vitest";
import { newBrowserSqliteDb } from "./browser-sqlite-db.js";

// The same WASM engine as in the browser, in memory: the shared suites run under Node too.
runDbConformance(() => newBrowserSqliteDb(), { placeholder: "?", skipFilePersistence: true });
runSqliteTransactionConformance(() => newBrowserSqliteDb());

describe("newBrowserSqliteDb under Node", () => {
  it("rejects a persistent path outside a Dedicated Worker", async () => {
    await expect(newBrowserSqliteDb({ path: "/data.db" })).rejects.toThrow(/Dedicated Worker/);
  });

  it("honors a different wasmUrl after an earlier call", async () => {
    await expect(newBrowserSqliteDb({ wasmUrl: "/nonexistent/sqlite3.wasm" })).rejects.toThrow();
    const wasmPath = createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
    const db = await newBrowserSqliteDb({ wasmUrl: wasmPath });
    try {
      expect(await db.query("SELECT 1 AS x")).toEqual([{ x: 1 }]);
    } finally {
      await db.close();
    }
  });
});
```

`packages/db-sqlite-browser/test/opfs-test-worker.ts`. This is the Dedicated Worker fixture. It types its global minimally so it compiles without the DOM or WebWorker libs.

```ts
import { newBrowserSqliteDb } from "../src/index.js";

type Message = { path: string; action: "write" | "count" };
const scope = globalThis as unknown as {
  onmessage: ((event: { data: Message }) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const db = await newBrowserSqliteDb({ path: data.path });
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS p (v INTEGER)");
      if (data.action === "write") await db.exec("INSERT INTO p VALUES (42)");
      const [row] = await db.query<{ n: number }>("SELECT count(*) AS n FROM p");
      scope.postMessage({ count: Number(row?.n) });
    } finally {
      await db.close();
    }
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
```

`packages/db-sqlite-browser/src/browser-sqlite-db.browser.test.ts`:
1. Change the header comment to say "the sqlite-wasm adapter".
2. Replace the conformance block with:

```ts
runDbConformance(() => newBrowserSqliteDb(), { placeholder: "?", skipFilePersistence: true });
runSqliteTransactionConformance(() => newBrowserSqliteDb());
```

3. Add `runSqliteTransactionConformance` to the import from `@statewalker/db-tests`.
4. Delete the whole `describe("vector search", ...)` block (libSQL-only functions).
5. Add the same trigram test as in Task 2, Step 1 to `describe("FTS5", ...)`.
6. Append:

```ts
type TestWorker = {
  onmessage: ((event: { data: { count?: number; error?: string } }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
};
const WorkerClass = (globalThis as unknown as {
  Worker: new (url: URL, options: { type: "module" }) => TestWorker;
}).Worker;

/** Run one action in a fresh Dedicated Worker, then terminate it (as a page reload would). */
function inWorker(message: { path: string; action: "write" | "count" }): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(new URL("../test/opfs-test-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(Number(data.count));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(message);
  });
}

describe("OPFS persistence (opfs-sahpool)", () => {
  it("rejects a persistent path on the main thread", async () => {
    await expect(newBrowserSqliteDb({ path: "/main-thread.db" })).rejects.toThrow(/Dedicated Worker/);
  });

  it("keeps a path's data from one worker to the next", async () => {
    const path = `/persist-${Date.now()}.db`;
    expect(await inWorker({ path, action: "write" })).toBe(1);
    expect(await inWorker({ path, action: "count" })).toBe(1);
  });
});
```

`packages/db-sqlite-browser/vitest.browser.config.ts`: replace the whole file.

```ts
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Vitest browser-mode config for the sqlite-wasm adapter: runs `*.browser.test.ts` in headless
 * Chromium. `@sqlite.org/sqlite-wasm` finds its `sqlite3.wasm` through `import.meta.url`, so it
 * is kept out of Vite's dependency pre-bundling, which would rewrite that URL. Workers are ES
 * modules so the OPFS fixture can import the driver.
 *
 * Launch with `pnpm test:browser` (run `pnpm exec playwright install chromium` once).
 */
export default defineConfig({
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  test: {
    include: ["src/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
```

`packages/db-sqlite-browser/package.json`:
- `"description": "SQLite WASM (@sqlite.org/sqlite-wasm) driver for @statewalker/db-api in the browser: in-memory anywhere, OPFS persistence in a Dedicated Worker."`;
- in `dependencies`, replace `"@libsql/libsql-wasm-experimental": "catalog:"` with `"@sqlite.org/sqlite-wasm": "catalog:"` and `"@statewalker/db-sqlite": "workspace:^"`.

`pnpm-workspace.yaml`: delete `'@libsql/libsql-wasm-experimental': ^0.0.3`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm install && pnpm --filter @statewalker/db-sqlite-browser test`
Expected: FAIL. The old source imports `@libsql/libsql-wasm-experimental`, which is no longer installed ("Failed to resolve import").

- [ ] **Step 3: Implement**

`packages/db-sqlite-browser/src/browser-sqlite-db.ts`:

```ts
import sqlite3InitModule, {
  type BindableValue,
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import type { Db, DbOptions } from "@statewalker/db-api";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";

export type BrowserDbOptions = DbOptions & {
  /** URL of `sqlite3.wasm`. Default: the package's own file, located by the bundler. */
  wasmUrl?: string;
};

const MAIN_THREAD_PATH =
  'newBrowserSqliteDb: { path } needs a Dedicated Worker (the "opfs-sahpool" OPFS VFS runs only ' +
  "there). On the main thread, omit path for an in-memory database.";

type InitModule = (module?: { locateFile?: (file: string) => string }) => Promise<Sqlite3Static>;

/** One engine per wasmUrl, started on first use; one OPFS pool per engine. */
const engines = new Map<string, Promise<Sqlite3Static>>();
const pools = new WeakMap<Sqlite3Static, Promise<SAHPoolUtil>>();

function getSqlite3(wasmUrl: string | undefined): Promise<Sqlite3Static> {
  const key = wasmUrl ?? "";
  let engine = engines.get(key);
  if (!engine) {
    engine = (sqlite3InitModule as InitModule)(
      wasmUrl ? { locateFile: (file) => (file.endsWith(".wasm") ? wasmUrl : file) } : undefined,
    );
    engines.set(key, engine);
  }
  return engine;
}

function getPool(sqlite3: Sqlite3Static): Promise<SAHPoolUtil> {
  let pool = pools.get(sqlite3);
  if (!pool) {
    pool = sqlite3.installOpfsSAHPoolVfs({});
    pools.set(sqlite3, pool);
  }
  return pool;
}

const inDedicatedWorker = () =>
  typeof (globalThis as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope !==
  "undefined";

/**
 * Create a SQLite {@link Db} on `@sqlite.org/sqlite-wasm`.
 *
 * @param options.path     OPFS database name; Dedicated Worker only. Omit for in-memory.
 * @param options.wasmUrl  URL of `sqlite3.wasm`, when the bundler cannot locate it.
 */
export async function newBrowserSqliteDb(options?: BrowserDbOptions): Promise<Db> {
  if (options?.path && !inDedicatedWorker()) throw new Error(MAIN_THREAD_PATH);
  const sqlite3 = await getSqlite3(options?.wasmUrl);
  const db: Database = options?.path
    ? new (await getPool(sqlite3)).OpfsSAHPoolDb(options.path)
    : new sqlite3.oo1.DB(":memory:", "c");
  return newSerialisedSqliteDb({
    all: (sql, params) =>
      db.exec({
        sql,
        bind: params.length > 0 ? (params as BindableValue[]) : undefined,
        rowMode: "object",
        returnValue: "resultRows",
      }) as Record<string, unknown>[],
    exec: (sql) => {
      db.exec(sql);
    },
    close: () => db.close(),
  });
}
```

`packages/db-sqlite-browser/vitest.config.ts`: in its comment, change "libSQL-WASM adapter" to "sqlite-wasm adapter".

- [ ] **Step 4: Run the tests and make sure they pass**

Run:
1. `pnpm --filter @statewalker/db-sqlite-browser test`
2. `pnpm exec playwright install chromium` (once)
3. `pnpm --filter @statewalker/db-sqlite-browser test:browser`

Expected:
- **Node:** 10 + 12 + 2 tests pass.
- **Browser:** the conformance and transaction suites, 4 FTS5 tests and 2 OPFS tests pass.

If the second worker fails with an OPFS lock error (`NoModificationAllowedError` / access handle), the first worker's handles were not yet released by `terminate()`. Fix it in the test, not the driver: `await new Promise((r) => setTimeout(r, 100))` between the two `inWorker` calls, with a comment saying why.

- [ ] **Step 5: README, repo-wide libSQL cleanup, changeset**

`packages/db-sqlite-browser/README.md`: rewrite it.

````markdown
# @statewalker/db-sqlite-browser

## What it is

A SQLite driver for the browser that implements `Db` from `@statewalker/db-api` on the official
WebAssembly build, `@sqlite.org/sqlite-wasm` (SQLite 3.53, FTS5 with the `unicode61`, `porter`
and `trigram` tokenizers). It opens an in-memory database anywhere, and a persistent database in
the origin-private file system (OPFS) from a Dedicated Worker. Its Db works with `inTransaction`
from `@statewalker/db-sqlite`.

## Why it exists

It lets code written against `Db` run on SQLite in the browser with the same SQL as on Node.js
(`@statewalker/db-sqlite-node`) and in Durable Objects (`@statewalker/db-sqlite-do`), so search
and storage code is written and tested once.

## How to use

```sh
pnpm add @statewalker/db-sqlite-browser
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-sqlite-browser` | `newBrowserSqliteDb`; types `BrowserDbOptions`, `Db`, `DbEntry`, `DbOptions` | browser: main thread (in-memory) or Dedicated Worker (OPFS) |

`newBrowserSqliteDb({ path?, wasmUrl? })` returns `Promise<Db>`. Without `path` the database is
in memory. With `path` it lives in OPFS through the `opfs-sahpool` VFS, which works only in a
Dedicated Worker. Use `?` placeholders. Bundlers must not pre-bundle `@sqlite.org/sqlite-wasm`
(Vite: `optimizeDeps.exclude`), or pass `wasmUrl`.

## Examples

```ts
// worker.ts — started with new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";

const db = await newBrowserSqliteDb({ path: "/notes.db" });
await db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(body)");
const hits = await db.query("SELECT rowid FROM notes WHERE notes MATCH ?", ["sqlite"]);
```

## Internals

- **Why OPFS only in a Dedicated Worker.** `opfs-sahpool` uses synchronous OPFS access handles,
  which browsers provide only in workers. It needs no `SharedArrayBuffer`, so no COOP/COEP
  headers. On the main thread a `path` rejects at once with
  `newBrowserSqliteDb: { path } needs a Dedicated Worker ...` rather than falling back to memory.
- **One worker owns a database.** The pool holds its OPFS files open while the worker lives; a
  second worker (or tab) opening the same `path` fails with an OPFS lock error until the first
  one is terminated.
- **The pool has room for a few files.** Its default capacity is 6 files, and each database also
  uses journal files, so a worker that opens many databases can run out of slots.
- **Calls are queued** and transactions open with `BEGIN IMMEDIATE` (see `@statewalker/db-sqlite`).
  Rows are plain objects; BLOBs are `Uint8Array`.
- **The engine loads once per `wasmUrl`.** A failed load (for example a wrong `wasmUrl`) is not
  retried for that URL.
- **Dependencies:** `@sqlite.org/sqlite-wasm` (the engine), `@statewalker/db-sqlite` (queue and
  transactions), `@statewalker/db-api` (types).

## License

MIT
````

Root `package.json`: `"description": "Database adapters: DuckDB, SQLite (Node.js, browser WASM, Durable Objects) and PGlite behind one Db interface."`

Root `README.md`:
- In "## What it is", replace "on DuckDB or on SQLite (libSQL), in the browser or in Node.js" with "on DuckDB, on SQLite (Node.js, browser WASM or a Durable Object) or on PGlite".
- In the layout diagram, replace `@libsql/libsql-wasm-` / `experimental` with `@sqlite.org/sqlite-wasm`, and `@libsql/client` with `node:sqlite`.
- Table rows:
  - ``| `packages/db-sqlite-browser` | `@statewalker/db-sqlite-browser`: the official SQLite WASM build; in memory anywhere, OPFS in a Dedicated Worker | npm |``
  - ``| `packages/db-sqlite-node` | `@statewalker/db-sqlite-node`: Node.js's built-in `node:sqlite` | npm |``
  - add ``| `packages/db-sqlite` | `@statewalker/db-sqlite`: `inTransaction` and the queue every SQLite driver uses | npm |``
  - add ``| `packages/db-sqlite-do` | `@statewalker/db-sqlite-do`: Durable Object SQLite, plus a Node.js fake | npm |``
- In "## Why it is the way it is", the "One conformance suite" bullet: replace the libSQL sentence with "The engines differ in the placeholder syntax (`?` for SQLite, `$1` for DuckDB and PGlite), which `runDbConformance` takes as an option. SQLite drivers also run `runSqliteTransactionConformance`."
- In "## What will surprise you":
  - the DuckDB bullet: replace "The libSQL browser tests serve `sqlite3.wasm` locally (the config's `publicDir`) and work offline." with "The SQLite browser tests load `sqlite3.wasm` from the installed package and work offline.";
  - the last bullet: replace "`newBrowserSqliteDb()` aborts because it cannot load `/sqlite3.wasm`" with "`newBrowserSqliteDb()` works in memory under Node.js but rejects a `path` (OPFS needs a Dedicated Worker)".

`packages/db-tests/README.md` and `db-conformance.suite.ts` comments: replace the libSQL row-normaliser explanation with "Some drivers return rows with a `null` prototype or extra non-enumerable keys; `(row) => ({ ...row })` keeps only the named columns." In the Internals bullet on engine-specific tests, replace "(libSQL `fts5`, `libsql_vector_idx`; DuckDB `fts` and `vss` extensions)" with "(SQLite FTS5; DuckDB `fts` and `vss`)".

Run `grep -rni libsql --include=*.md --include=*.ts --include=*.json --include=*.yaml . | grep -v node_modules | grep -v CHANGELOG | grep -v pnpm-lock`.
Expected: no output.

`.changeset/db-sqlite-browser-sqlite-wasm.md`:

```markdown
---
"@statewalker/db-sqlite-browser": minor
---

Breaking: the engine is now `@sqlite.org/sqlite-wasm` instead of `@libsql/libsql-wasm-experimental`. A `path` opens an OPFS database through `opfs-sahpool` and is accepted only in a Dedicated Worker; `wasmUrl` now defaults to the package's own `sqlite3.wasm`; libSQL vector functions are gone; the Db supports `inTransaction` from `@statewalker/db-sqlite`.
```

- [ ] **Step 6: Verify and commit**

Run:
1. `pnpm --filter @statewalker/db-sqlite-browser test && pnpm --filter @statewalker/db-sqlite-browser test:browser && pnpm --filter @statewalker/consumer-install-tests test`
2. `pnpm typecheck`
3. `pnpm biome check --write --unsafe`

```bash
git add packages/db-sqlite-browser packages/db-tests pnpm-workspace.yaml pnpm-lock.yaml package.json README.md .changeset/db-sqlite-browser-sqlite-wasm.md
git commit -m "feat(db-sqlite-browser)!: run on @sqlite.org/sqlite-wasm with OPFS (opfs-sahpool) in a Dedicated Worker"
```

---

### Task 6: `@statewalker/db-pglite`

**Files:**
- Create: `packages/db-pglite/package.json`, `tsconfig.json`, `README.md`, `src/index.ts`, `src/pglite-db.ts`, `src/pglite-db.test.ts`
- Modify: `pnpm-workspace.yaml` (catalog), `tools/consumer-install/consumer-install.test.ts`, root `README.md` (table and diagram)
- Create: `.changeset/db-pglite.md`

**Interfaces:**
- **Consumes:** `runDbConformance` (Task 1).
- **Produces:**
  - `newPgliteDb(options?: PgliteDbOptions): Promise<Db>`, with `type PgliteDbOptions = { path?: string; extensions?: Record<string, unknown> }`;
  - it uses `$n` placeholders.
  - P5's `indexer-pglite` 0.3 calls it as `createPGLiteIndexer({ db: await newPgliteDb({ extensions: { vector } }) })`.

- [ ] **Step 1: Scaffold and write the failing test**

`pnpm-workspace.yaml` catalog: add the same versions as statewalker-search:

```yaml
  "@electric-sql/pglite": ^0.5.8
  # pgvector left the pglite package in 0.5 (was @electric-sql/pglite/vector)
  "@electric-sql/pglite-pgvector": ^0.0.9
```

`packages/db-pglite/package.json`: the fields are those of `db-sqlite` (Task 1, Step 1) with:
- `name` `@statewalker/db-pglite`;
- `description` `"PGlite (Postgres in WASM) driver for @statewalker/db-api, for Node.js and the browser."`;
- `homepage` and `repository.directory` pointing at `packages/db-pglite`;
- `"test": "vitest run"`;
- dependencies `{ "@electric-sql/pglite": "catalog:", "@statewalker/db-api": "workspace:^" }`;
- devDependencies adding `"@electric-sql/pglite-pgvector": "catalog:"`, `"@statewalker/db-tests": "workspace:^"` and `"@types/node": "catalog:"`.

`packages/db-pglite/tsconfig.json`: copy `packages/db-sqlite-node/tsconfig.json`.

`packages/db-pglite/src/pglite-db.test.ts`:

```ts
import { vector } from "@electric-sql/pglite-pgvector";
import { runDbConformance } from "@statewalker/db-tests";
import { describe, expect, it } from "vitest";
import { newPgliteDb } from "./pglite-db.js";

runDbConformance((options) => newPgliteDb(options), { placeholder: "$1" });

describe("newPgliteDb", () => {
  it("loads the extensions it is given (pgvector, as indexer-pglite needs)", async () => {
    const db = await newPgliteDb({ extensions: { vector } });
    try {
      await db.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE v (e vector(3))");
      await db.query("INSERT INTO v VALUES ($1::vector)", ["[1,2,3]"]);
      const rows = await db.query<{ d: number }>("SELECT e <-> '[1,2,4]'::vector AS d FROM v");
      expect(rows[0]?.d).toBeCloseTo(1);
    } finally {
      await db.close();
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm install && pnpm --filter @statewalker/db-pglite test`
Expected: FAIL with "Cannot find module './pglite-db.js'".

- [ ] **Step 3: Implement**

`packages/db-pglite/src/pglite-db.ts`:

```ts
import { type Extensions, PGlite } from "@electric-sql/pglite";
import type { Db, DbEntry } from "@statewalker/db-api";

export type PgliteDbOptions = {
  /** PGlite data directory: a folder on Node.js, `idb://<name>` in a browser. Omit for in-memory. */
  path?: string;
  /** PGlite extensions to load, e.g. `{ vector }` from `@electric-sql/pglite-pgvector`. */
  extensions?: Record<string, unknown>;
};

/** Create a {@link Db} on PGlite. Use `$1`, `$2`, ... placeholders. */
export async function newPgliteDb(options?: PgliteDbOptions): Promise<Db> {
  const pg = await PGlite.create({
    dataDir: options?.path,
    extensions: options?.extensions as Extensions | undefined,
  });
  let closed = false;
  const live = () => {
    if (closed) throw new Error("db-pglite: the database is closed");
  };
  return {
    async query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]> {
      live();
      return (await pg.query<T>(sql, params ?? [])).rows;
    },
    async exec(sql: string): Promise<void> {
      live();
      await pg.exec(sql);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pg.close();
    },
  };
}
```

`packages/db-pglite/src/index.ts`:

```ts
export type { Db, DbEntry } from "@statewalker/db-api";
export { newPgliteDb, type PgliteDbOptions } from "./pglite-db.js";
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm --filter @statewalker/db-pglite test`
Expected: PASS. That is 10 Db conformance tests (file persistence included: `path` is a PGlite data directory) and 1 extension test.

- [ ] **Step 5: README, consumer-install, changeset**

`packages/db-pglite/README.md`:

````markdown
# @statewalker/db-pglite

## What it is

A driver that implements `Db` from `@statewalker/db-api` on PGlite, Postgres compiled to
WebAssembly, in Node.js or in the browser. Extensions such as pgvector are passed in by the
caller.

## Why it exists

Postgres-backed code (full-text search with `tsvector`, pgvector indexes) can then take a `Db`
like every other engine here, instead of a `PGlite` instance, and be tested with the same
conformance suite.

## How to use

```sh
pnpm add @statewalker/db-pglite @electric-sql/pglite
```

| Import | Gives | Environment |
| --- | --- | --- |
| `@statewalker/db-pglite` | `newPgliteDb`; types `PgliteDbOptions`, `Db`, `DbEntry` | Node.js, browser |

`newPgliteDb({ path?, extensions? })` returns `Promise<Db>`. Use `$1`, `$2`, ... placeholders.
`exec` runs several statements; `query` runs one, with parameters.

## Examples

```ts
import { vector } from "@electric-sql/pglite-pgvector";
import { newPgliteDb } from "@statewalker/db-pglite";

const db = await newPgliteDb({ path: "./pgdata", extensions: { vector } });
await db.exec("CREATE EXTENSION IF NOT EXISTS vector");
const rows = await db.query("SELECT $1::int + 1 AS n", [41]);
```

## Internals

- **`path` is a PGlite data directory**, not a file: a folder on Node.js, `idb://<name>`
  (IndexedDB) in a browser. Omit it for an in-memory database. This package's tests run on
  Node.js only.
- **The caller owns extensions.** The driver loads what it is given and never runs
  `CREATE EXTENSION`; do that after opening.
- **No transactions helper.** `inTransaction` from `@statewalker/db-sqlite` is SQLite-only and
  rejects this Db. Postgres runs `BEGIN ... COMMIT` as ordinary SQL inside one `exec`.
- **After `close()`** every call rejects with `db-pglite: the database is closed`; a second
  `close()` does nothing.
- **Dependencies:** `@electric-sql/pglite` (the engine), `@statewalker/db-api` (types).

## License

MIT
````

`tools/consumer-install/consumer-install.test.ts`: add `{ name: "@statewalker/db-pglite", dir: "db-pglite", subpaths: ["."] },`.

Root `README.md`:
- add the table row ``| `packages/db-pglite` | `@statewalker/db-pglite`: PGlite (Postgres in WASM), Node.js and browser | npm |``;
- in the layout diagram, add `db-pglite` (`@electric-sql/pglite`) beside the other drivers;
- update "one database interface and four drivers" to "one database interface and its drivers" in "## What it is" and in the layout heading.

`.changeset/db-pglite.md`:

```markdown
---
"@statewalker/db-pglite": minor
---

New package: `newPgliteDb({ path?, extensions? })`, a Db on PGlite with caller-supplied extensions.
```

- [ ] **Step 6: Verify and commit**

Run:
1. `pnpm test` (the whole workspace, including consumer-install)
2. `pnpm typecheck`
3. `pnpm biome check --write --unsafe`

```bash
git add packages/db-pglite pnpm-workspace.yaml pnpm-lock.yaml tools/consumer-install README.md .changeset/db-pglite.md
git commit -m "feat(db-pglite): PGlite driver for Db with caller-supplied extensions"
```

---

## Self-Review

**1. Spec coverage**

- **D1** (`db-api` unchanged, async only): a Global Constraint. No task edits `packages/db-api`.
- **D2:** Task 1.
  - Implemented: the hook; nesting throws; wrappers rejected (with the error text in the README); the callback rules; DML through `query`; `changes()` and `RETURNING`; BLOBs as `Uint8Array`.
  - `json_each` is a scenario.
  - The mutex plus `BEGIN IMMEDIATE` lives in `newSerialisedSqliteDb`.
- **D3:** Tasks 2, 3 and 5.
  - The DO driver's transaction goes through `storage.transaction`, and its BLOBs are converted.
  - **Refinement:** DO `close` marks the Db closed, because `runDbConformance` requires calls after `close` to reject. Flagged in the Task 3 Interfaces.
  - libSQL is removed in Tasks 2 and 5, and the grep check sits in Task 5.
- **D5 (the `db-pglite` part):** Task 6. `indexer-pglite` moving to `{ db }` belongs to P5 in statewalker-search.
- **D14, Db level:**
  - Db conformance runs on node, browser (Node and Chromium), the DO fake, real DO and pglite.
  - `runSqliteTransactionConformance` has all seven required cases plus the five Review Focus cases.
  - DO is tested both ways: the fake in Task 3 and celld in Task 4.
  - The celld 0.6.x upgrade is Task 4, Step 1.
- **D15:** P0 is Task 4; P1 is Tasks 1–3, 5 and 6.
- **Not in this plan:** `db-sqlite-index` (P2/P3), `webrun-files-sqlite` (P4) and statewalker-search (P5). Each has its own plan.

**2. Placeholder scan.** Every code step has full code.
- The README edits give the exact replacement text.
- The only open values are the celld 0.6 patch number and the probe outcome. Task 4 Steps 1, 3 and 4 say how to obtain and record them.

**3. Type consistency.**
- `SqliteEngine`'s optional `transaction` is used by `db-sqlite-do`.
- `newSerialisedSqliteDb` is used by node, browser and do, and by the db-tests fixture.
- `DoSqlStorage` is used by the fake, the probe and the worker.
- `sqliteTransactionScenarios` is used by both the vitest runner and, through `test-do/scenarios.ts` (`SCENARIOS`), the worker; P2 and P3 append their smoke scenarios to `SCENARIOS` by relative import.
- `PROBE_EXPECTATIONS` is used by both the fake test and the `test:do` test.

**4. Review Focus.** All five lines have tests:
1. the "exec runs every statement" scenario and the `multiStatementExec` probe;
2. the "transaction handle rejects once finished" scenario;
3. the "plain write survives rollback" scenario;
4. the main-thread path tests on Node and in Chromium;
5. the "close waits" scenario.
