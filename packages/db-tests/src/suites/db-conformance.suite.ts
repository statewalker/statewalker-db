/**
 * Shared conformance suite for the {@link Db} contract.
 *
 * One behavioral spec, run against any `Db` implementation through its public
 * surface (`query`, `exec`, optional `flush`, `close`). Runs in both Node and a
 * real browser (Vitest browser mode) — the only node-only scenario is the file
 * persistence one, which writes to a real temp directory via `node:fs`. Browser
 * adapters pass `{ skipFilePersistence: true }` to drop it; the node imports it
 * needs are loaded through a `/* @vite-ignore *\/` dynamic import *inside* the
 * scenario, so a browser bundle never has to resolve `node:fs` at all.
 *
 * The two axes that differ between dialects are parameters, not forks in the
 * suite:
 *  - **placeholder** — `?` (sqlite) vs `$1` (duckdb).
 *  - **normalizeRow** — projects a raw driver row to a plain object. Some
 *    drivers return rows with a `null` prototype or extra non-enumerable keys;
 *    `(row) => ({ ...row })` keeps only the named columns.
 */

import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";
import { describe, expect, type TestFunction, it as vitestIt } from "vitest";

/** Async factory producing a fresh `Db`; `{ path }` selects a file backend. */
export type MakeDb = (options?: DbOptions) => Promise<Db>;

export interface RunDbConformanceOptions {
  /** Dialect placeholder for a single positional parameter (`?` or `$1`). */
  placeholder: string;
  /**
   * Optional per-row normalizer applied before matching. Use it to strip
   * driver-specific row cruft (e.g. a `null` prototype or extra non-enumerable keys) so a plain
   * `toEqual` works. Defaults to identity.
   */
  normalizeRow?: (row: DbEntry) => DbEntry;
  /**
   * Skip the node-only file-persistence scenario, which uses `node:fs` temp
   * files. Browser adapters (Vitest browser mode) set this `true`; node
   * adapters leave it unset. Defaults to `false` (node behavior unchanged).
   */
  skipFilePersistence?: boolean;
  /**
   * Column type the BLOB round trip declares: `BLOB` (default; SQLite, DuckDB) or `BYTEA`
   * (Postgres, PGlite).
   */
  blobType?: string;
  /**
   * Scenario names (the `it` titles) a platform cannot meet, each skipped instead of run. Say
   * why next to the list.
   */
  skip?: string[];
}

/** Every `Db` rejects a call made once `close()` has started with an error saying this. */
const CLOSED = /the database is closed/;

/** A query that keeps the engine busy for a moment, so a later call finds it in flight. */
const SLOW_COUNT =
  "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 100) " +
  "SELECT count(*) AS n FROM r a, r b, r c";

/**
 * Register the shared `Db` conformance scenarios for one adapter.
 *
 * @param makeDb   fresh-`Db` factory (accepts `{ path }` for file backends)
 * @param options  dialect placeholder + optional row normalizer
 */
export function runDbConformance(makeDb: MakeDb, options: RunDbConformanceOptions): void {
  const { placeholder } = options;
  const normalize = options.normalizeRow ?? ((row: DbEntry) => row);
  const blobType = options.blobType ?? "BLOB";
  const skipped = new Set(options.skip ?? []);
  const it = (name: string, fn: TestFunction) =>
    (skipped.has(name) ? vitestIt.skip : vitestIt)(name, fn);

  const expectRow = (actual: unknown, expected: DbEntry): void => {
    expect(normalize(actual as DbEntry)).toEqual(expected);
  };

  describe("Db conformance", () => {
    // Requirement: the suite runs unmodified against every node adapter.
    it("the factory yields an object conforming to the Db contract", async () => {
      const db = await makeDb();
      try {
        expect(typeof db.query).toBe("function");
        expect(typeof db.exec).toBe("function");
        expect(typeof db.close).toBe("function");
      } finally {
        await db.close();
      }
    });

    // Requirement: exec runs non-returning statements; effects are visible.
    it("exec creates a table and inserts a row visible to a later query", async () => {
      const db = await makeDb();
      try {
        const execResult = await db.exec("CREATE TABLE users (id INTEGER, name VARCHAR)");
        expect(execResult).toBeUndefined();
        await db.exec("INSERT INTO users VALUES (1, 'Alice')");

        const rows = await db.query("SELECT id, name FROM users");
        expect(rows).toHaveLength(1);
        expectRow(rows[0], { id: 1, name: "Alice" });
      } finally {
        await db.close();
      }
    });

    // Requirement: query binds parameters and returns typed rows.
    it("binds a positional parameter and returns the matching typed row", async () => {
      const db = await makeDb();
      try {
        await db.exec("CREATE TABLE items (id INTEGER, label VARCHAR)");
        await db.exec("INSERT INTO items VALUES (1, 'one'), (2, 'two'), (3, 'three')");

        const rows = await db.query<{ id: number; label: string }>(
          `SELECT id, label FROM items WHERE id = ${placeholder}`,
          [2],
        );

        expect(rows).toHaveLength(1);
        expectRow(rows[0], { id: 2, label: "two" });
        expect(typeof rows[0]?.id).toBe("number");
        expect(typeof rows[0]?.label).toBe("string");
      } finally {
        await db.close();
      }
    });

    // Requirement: a bound parameter is a literal, never interpreted as SQL.
    it("treats a SQL-metacharacter parameter as a literal value (no injection)", async () => {
      const db = await makeDb();
      try {
        await db.exec("CREATE TABLE accounts (id INTEGER, name VARCHAR)");
        // Row 2's name is literally the string `' OR 1=1`.
        await db.exec("INSERT INTO accounts VALUES (1, 'Alice'), (2, ''' OR 1=1')");

        const rows = await db.query<{ id: number }>(
          `SELECT id FROM accounts WHERE name = ${placeholder}`,
          ["' OR 1=1"],
        );

        // Injection would make the predicate `... = '' OR 1=1` → both rows.
        // Literal binding matches only the row equal to that exact string.
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]?.id)).toBe(2);
      } finally {
        await db.close();
      }
    });

    // Requirement: query result cardinality is exact — empty case.
    it("returns an empty array (length 0) when nothing matches", async () => {
      const db = await makeDb();
      try {
        await db.exec("CREATE TABLE e (id INTEGER)");
        await db.exec("INSERT INTO e VALUES (1)");

        const rows = await db.query(`SELECT id FROM e WHERE id = ${placeholder}`, [999]);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows).toHaveLength(0);
      } finally {
        await db.close();
      }
    });

    // Requirement: query result cardinality is exact — multi-row case.
    it("returns every matching row for a multi-row result", async () => {
      const db = await makeDb();
      try {
        await db.exec("CREATE TABLE m (id INTEGER, label VARCHAR)");
        await db.exec("INSERT INTO m VALUES (1, 'a'), (2, 'b'), (3, 'c')");

        const rows = await db.query("SELECT id, label FROM m ORDER BY id");
        expect(rows).toHaveLength(3);
        expectRow(rows[0], { id: 1, label: "a" });
        expectRow(rows[1], { id: 2, label: "b" });
        expectRow(rows[2], { id: 3, label: "c" });
      } finally {
        await db.close();
      }
    });

    // Requirement: optional flush persists pending writes (skip when absent).
    it("flush, when defined, makes prior writes observable", async (ctx) => {
      const db = await makeDb();
      try {
        if (typeof db.flush !== "function") {
          ctx.skip();
          return;
        }
        await db.exec("CREATE TABLE f (id INTEGER)");
        await db.exec("INSERT INTO f VALUES (7)");
        await db.flush();

        const rows = await db.query<{ id: number }>("SELECT id FROM f");
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]?.id)).toBe(7);
      } finally {
        await db.close();
      }
    });

    // Requirement: close releases the connection; later use must not succeed.
    it("rejects query and exec issued after close", async () => {
      const db = await makeDb();
      await db.exec("CREATE TABLE c (id INTEGER)");
      await db.close();

      await expect(db.query("SELECT id FROM c")).rejects.toThrow(CLOSED);
      await expect(db.exec("SELECT 1")).rejects.toThrow(CLOSED);
      if (typeof db.flush === "function") await expect(db.flush()).rejects.toThrow(CLOSED);
    });

    // Requirement: close() waits for the calls made before it, then closes.
    it("close waits for an in-flight query, then closes", async () => {
      const db = await makeDb();
      const slow = db.query<{ n: unknown }>(SLOW_COUNT);
      const queued = db.query<{ x: unknown }>("SELECT 1 AS x");
      const closed = db.close();
      const [slowRows, queuedRows] = await Promise.all([slow, queued, closed]);
      expect(Number(slowRows[0]?.n)).toBe(1000000);
      expect(Number(queuedRows[0]?.x)).toBe(1);
      await expect(db.query("SELECT 1 AS x")).rejects.toThrow(CLOSED);
    });

    // Requirement: a call made once close() has started rejects with a clean error.
    it("calls made after close has started reject with 'the database is closed'", async () => {
      const db = await makeDb();
      await db.exec("CREATE TABLE late (id INTEGER)");
      const busy = db.query(SLOW_COUNT);
      const closed = db.close();
      const late: Promise<unknown>[] = [
        db.query("SELECT 1 AS x"),
        db.exec("INSERT INTO late VALUES (1)"),
      ];
      if (typeof db.flush === "function") late.push(db.flush());
      // Settle everything at once, so no rejection goes unhandled while another is awaited.
      const [busyResult, closeResult, ...lateResults] = await Promise.allSettled([
        busy,
        closed,
        ...late,
      ]);
      expect(busyResult?.status).toBe("fulfilled");
      expect(closeResult?.status).toBe("fulfilled");
      for (const result of lateResults) {
        expect(result.status).toBe("rejected");
        expect(String((result as PromiseRejectedResult).reason)).toMatch(CLOSED);
      }
    });

    // Requirement: closing twice is a no-op, whether the calls overlap or not.
    it("closing twice is a no-op", async () => {
      const db = await makeDb();
      await db.exec("CREATE TABLE twice (id INTEGER)");
      await expect(Promise.all([db.close(), db.close()])).resolves.toBeDefined();
      await expect(db.close()).resolves.toBeUndefined();
      await expect(db.query("SELECT id FROM twice")).rejects.toThrow(CLOSED);
    });

    // Requirement: calls run one at a time, in call order, without awaiting each other.
    it("concurrent calls run in call order", async () => {
      const db = await makeDb();
      try {
        const calls: Promise<unknown>[] = [db.exec("CREATE TABLE ord (n INTEGER)")];
        const counts: Promise<{ n: unknown }[]>[] = [];
        for (let i = 1; i <= 10; i++) {
          calls.push(db.exec(`INSERT INTO ord VALUES (${i})`));
          counts.push(db.query<{ n: unknown }>("SELECT count(*) AS n FROM ord"));
        }
        await Promise.all(calls);
        const seen = (await Promise.all(counts)).map((rows) => Number(rows[0]?.n));
        expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      } finally {
        await db.close();
      }
    });

    // Requirement: a BLOB comes back as a Uint8Array with the same bytes.
    it("a BLOB parameter round-trips as a Uint8Array", async () => {
      const db = await makeDb();
      try {
        await db.exec(`CREATE TABLE blobs (k INTEGER, v ${blobType})`);
        const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
        await db.exec("INSERT INTO blobs VALUES (1, NULL)");
        await db.query(`INSERT INTO blobs VALUES (2, ${placeholder})`, [bytes]);
        const rows = await db.query<{ v: unknown }>("SELECT v FROM blobs ORDER BY k");
        expect(rows[0]?.v).toBeNull();
        expect(rows[1]?.v).toBeInstanceOf(Uint8Array);
        expect(Array.from(rows[1]?.v as Uint8Array)).toEqual(Array.from(bytes));
      } finally {
        await db.close();
      }
    });

    // Requirement: integers are numbers within ±(2^53 - 1) and bigints beyond, whatever the
    // column type (INTEGER, BIGINT, count(*)).
    it("integers come back as numbers when safe and as bigints beyond 2^53", async () => {
      const db = await makeDb();
      try {
        await db.exec("CREATE TABLE ints (k INTEGER, v BIGINT)");
        const big = 9007199254740993n; // 2^53 + 1
        await db.query(`INSERT INTO ints VALUES (1, ${placeholder})`, [5n]);
        await db.query(`INSERT INTO ints VALUES (2, ${placeholder})`, [big]);
        await db.query(`INSERT INTO ints VALUES (3, ${placeholder})`, [-big]);
        await db.exec(`INSERT INTO ints VALUES (4, ${Number.MAX_SAFE_INTEGER})`);
        const rows = await db.query("SELECT k, v FROM ints ORDER BY k");
        expect(rows.map(normalize)).toEqual([
          { k: 1, v: 5 },
          { k: 2, v: big },
          { k: 3, v: -big },
          { k: 4, v: Number.MAX_SAFE_INTEGER },
        ]);
        const [count] = await db.query("SELECT count(*) AS n FROM ints");
        expectRow(count, { n: 4 });
      } finally {
        await db.close();
      }
    });

    // Requirement: a DECIMAL keeps its value. Its JS type is the engine's (number on SQLite and
    // DuckDB, an exact decimal string on PGlite), so the check compares numeric values.
    it("a DECIMAL round-trips to the same numeric value", async () => {
      const db = await makeDb();
      try {
        await db.exec("CREATE TABLE decs (k INTEGER, v DECIMAL(10,2))");
        await db.exec("INSERT INTO decs VALUES (1, 1.25)");
        await db.query(`INSERT INTO decs VALUES (2, ${placeholder})`, [-2.5]);
        const rows = await db.query<{ v: unknown }>("SELECT v FROM decs ORDER BY k");
        for (const { v } of rows) expect(["number", "string"]).toContain(typeof v);
        expect(rows.map(({ v }) => Number(v))).toEqual([1.25, -2.5]);
      } finally {
        await db.close();
      }
    });

    // Requirement: a Date parameter keeps its instant. It comes back as a Date where the engine
    // has a timestamp type (DuckDB, PGlite) and as ISO 8601 UTC text on SQLite.
    it("a Date parameter round-trips to the same instant", async () => {
      const db = await makeDb();
      try {
        await db.exec("CREATE TABLE dates (v TIMESTAMP)");
        const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
        await db.query(`INSERT INTO dates VALUES (${placeholder})`, [date]);
        const [row] = await db.query<{ v: unknown }>("SELECT v FROM dates");
        const v = row?.v;
        expect(v instanceof Date || typeof v === "string").toBe(true);
        expect(new Date(v as Date | string).getTime()).toBe(date.getTime());
      } finally {
        await db.close();
      }
    });

    // Requirement: file-backed databases persist across reopen (node-only).
    // The node built-ins are loaded through a string-variable dynamic import
    // typed by a local shim, so neither a browser bundle (Vite cannot statically
    // analyze a variable specifier) nor a browser typecheck (no `node:*` type
    // resolution, hence no `@types/node`) ever has to resolve them. Browser
    // adapters skip the scenario outright via `skipFilePersistence`.
    interface NodeFsShim {
      mkdtemp: (prefix: string) => Promise<string>;
      rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
      tmpdir: () => string;
      join: (...parts: string[]) => string;
    }
    const loadNode = (specifier: string): Promise<NodeFsShim> =>
      import(/* @vite-ignore */ specifier) as Promise<NodeFsShim>;
    const filePersistenceIt = options.skipFilePersistence ? vitestIt.skip : it;
    filePersistenceIt(
      "persists file-backed data across close and reopen on the same path",
      async () => {
        const { mkdtemp, rm } = await loadNode("node:fs/promises");
        const { tmpdir } = await loadNode("node:os");
        const { join } = await loadNode("node:path");
        const dir = await mkdtemp(join(tmpdir(), "db-conformance-"));
        const path = join(dir, "data.db");
        try {
          const db1 = await makeDb({ path });
          await db1.exec("CREATE TABLE p (val INTEGER)");
          await db1.exec("INSERT INTO p VALUES (42)");
          await db1.close();

          const db2 = await makeDb({ path });
          const rows = await db2.query<{ val: number }>("SELECT val FROM p");
          await db2.close();

          expect(rows).toHaveLength(1);
          expect(Number(rows[0]?.val)).toBe(42);
        } finally {
          // Removes the db file and any -wal/-shm/.wal sidecars in the temp dir.
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    // Requirement: invalid SQL is reported as an error.
    it("rejects syntactically invalid SQL rather than resolving", async () => {
      const db = await makeDb();
      try {
        await expect(db.query("SELCT nonsense FROM")).rejects.toThrow();
        await expect(db.exec("CREATE TABLE (")).rejects.toThrow();
      } finally {
        await db.close();
      }
    });
  });
}
