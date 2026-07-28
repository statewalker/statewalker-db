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
 *  - **normalizeRow** — projects a raw driver row to a plain object so one
 *    matcher serves both duckdb (already-plain rows) and libsql (whose Row
 *    objects also expose non-enumerable positional keys + `length`). Adapters
 *    pass `(row) => ({ ...row })`; the copy keeps only the named columns.
 */

import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";
import { describe, expect, it } from "vitest";

/** Async factory producing a fresh `Db`; `{ path }` selects a file backend. */
export type MakeDb = (options?: DbOptions) => Promise<Db>;

export interface RunDbConformanceOptions {
  /** Dialect placeholder for a single positional parameter (`?` or `$1`). */
  placeholder: string;
  /**
   * Optional per-row normalizer applied before matching. Use it to strip
   * driver-specific row cruft (e.g. libsql's positional keys) so a plain
   * `toEqual` works. Defaults to identity.
   */
  normalizeRow?: (row: DbEntry) => DbEntry;
  /**
   * Skip the node-only file-persistence scenario, which uses `node:fs` temp
   * files. Browser adapters (Vitest browser mode) set this `true`; node
   * adapters leave it unset. Defaults to `false` (node behavior unchanged).
   */
  skipFilePersistence?: boolean;
}

/**
 * Register the shared `Db` conformance scenarios for one adapter.
 *
 * @param makeDb   fresh-`Db` factory (accepts `{ path }` for file backends)
 * @param options  dialect placeholder + optional row normalizer
 */
export function runDbConformance(makeDb: MakeDb, options: RunDbConformanceOptions): void {
  const { placeholder } = options;
  const normalize = options.normalizeRow ?? ((row: DbEntry) => row);

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

      await expect(db.query("SELECT id FROM c")).rejects.toThrow();
      await expect(db.exec("SELECT 1")).rejects.toThrow();
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
    const filePersistenceIt = options.skipFilePersistence ? it.skip : it;
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
