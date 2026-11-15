import * as duckdb from "@duckdb/duckdb-wasm";
import type { Db } from "@statewalker/db-api";
import { runDbConformance } from "@statewalker/db-tests";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newBrowserDuckDb } from "./browser-duckdb.js";

/**
 * The DuckDB-WASM browser adapter, exercised in a REAL browser (Vitest browser
 * mode + Playwright/Chromium). Launched only by `vitest.browser.config.ts` (the
 * `test:browser` script) — the Node config excludes `*.browser.test.ts`.
 *
 * With no `bundles`/`path`, the adapter loads the default DuckDB bundle from
 * jsDelivr and runs in-memory (a Worker inside the browser page), so the run
 * needs outbound network access from Chromium. The node-only file-persistence
 * scenario is skipped via `skipFilePersistence`.
 */

// Shared contract: CRUD, parameter binding, injection safety, cardinality,
// close, flush, error paths. File persistence is node-only, hence skipped here.
runDbConformance(() => newBrowserDuckDb(), {
  // duckdb dialect: `$1` placeholder; rows are already plain objects, so the
  // spread normalizer is an identity-style copy.
  placeholder: "$1",
  normalizeRow: (row) => ({ ...row }),
  skipFilePersistence: true,
});

// Dialect-specific browser behavior the shared suite does not cover: DuckDB's
// FTS extension and VSS/HNSW vector index.
describe("newBrowserDuckDb", () => {
  let db: Db;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe("FTS extension", () => {
    it("returns empty results for unmatched search terms", async () => {
      db = await newBrowserDuckDb();
      await db.exec("INSTALL fts; LOAD fts;");
      await db.exec("CREATE TABLE docs2 (id INTEGER, content VARCHAR)");
      await db.exec("INSERT INTO docs2 VALUES (1, 'hello world'), (2, 'goodbye world')");
      await db.exec("PRAGMA create_fts_index('docs2', 'id', 'content')");

      const rows = await db.query<{ id: number; score: number | null }>(`
        SELECT id, score FROM (
          SELECT *, fts_main_docs2.match_bm25(id, 'nonexistent') AS score FROM docs2
        ) sq WHERE score IS NOT NULL
      `);
      expect(rows).toHaveLength(0);
    });

    it("searches across multiple text columns", async () => {
      db = await newBrowserDuckDb();
      await db.exec("INSTALL fts; LOAD fts;");
      await db.exec("CREATE TABLE articles (id INTEGER, title VARCHAR, body VARCHAR)");
      await db.exec(`
        INSERT INTO articles VALUES
          (1, 'Travel Guide', 'Visit the beautiful lakes of Switzerland'),
          (2, 'Cooking Tips', 'How to make a perfect lake trout'),
          (3, 'Programming', 'Learn about SQL databases')
      `);
      await db.exec("PRAGMA create_fts_index('articles', 'id', 'title', 'body')");

      const rows = await db.query<{ id: number; score: number | null }>(`
        SELECT id, score FROM (
          SELECT *, fts_main_articles.match_bm25(id, 'lake') AS score FROM articles
        ) sq WHERE score IS NOT NULL
      `);
      expect(rows.length).toBe(2);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(1);
      expect(ids).toContain(2);
    });

    it("creates an FTS index and performs full-text search", async () => {
      db = await newBrowserDuckDb();
      await db.exec("INSTALL fts; LOAD fts;");
      await db.exec("CREATE TABLE docs (id INTEGER, content VARCHAR)");
      await db.exec(`
        INSERT INTO docs VALUES
          (1, 'the quick brown fox jumps over the lazy dog'),
          (2, 'a lazy cat sleeps on the mat'),
          (3, 'the fox and the hound are friends')
      `);
      await db.exec("PRAGMA create_fts_index('docs', 'id', 'content')");

      const rows = await db.query<{
        id: number;
        content: string;
        score: number | null;
      }>(`
        SELECT id, content, score
        FROM (
          SELECT *, fts_main_docs.match_bm25(id, 'fox') AS score
          FROM docs
        ) sq
        WHERE score IS NOT NULL
        ORDER BY score
      `);

      expect(rows.length).toBeGreaterThanOrEqual(1);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(1);
      expect(ids).toContain(3);
    });
  });

  describe("VSS extension", () => {
    it("creates HNSW index and performs vector similarity search", async () => {
      db = await newBrowserDuckDb();
      await db.exec("INSTALL vss; LOAD vss;");
      await db.exec("CREATE TABLE embeddings (id INTEGER, vec FLOAT[3])");
      await db.exec(`
        INSERT INTO embeddings VALUES
          (1, [1.0, 0.0, 0.0]),
          (2, [0.0, 1.0, 0.0]),
          (3, [0.0, 0.0, 1.0])
      `);
      await db.exec("CREATE INDEX vec_idx ON embeddings USING HNSW (vec)");

      const rows = await db.query<{ id: number }>(
        "SELECT id FROM embeddings ORDER BY array_distance(vec, [1.0, 0.1, 0.0]::FLOAT[3]) LIMIT 1",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(1);
    });

    it("returns k nearest neighbors ordered by distance", async () => {
      db = await newBrowserDuckDb();
      await db.exec("INSTALL vss; LOAD vss;");
      await db.exec("CREATE TABLE vectors (id INTEGER, vec FLOAT[3])");
      await db.exec(`
        INSERT INTO vectors VALUES
          (1, [1.0, 0.0, 0.0]),
          (2, [0.9, 0.1, 0.0]),
          (3, [0.0, 1.0, 0.0]),
          (4, [0.0, 0.0, 1.0])
      `);
      await db.exec("CREATE INDEX vec_idx2 ON vectors USING HNSW (vec)");

      const rows = await db.query<{ id: number }>(
        "SELECT id FROM vectors ORDER BY array_distance(vec, [1.0, 0.0, 0.0]::FLOAT[3]) LIMIT 2",
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe(1);
      expect(rows[1]?.id).toBe(2);
    });

    it("works without HNSW index (brute-force scan)", async () => {
      db = await newBrowserDuckDb();
      await db.exec("INSTALL vss; LOAD vss;");
      await db.exec("CREATE TABLE vecs_no_idx (id INTEGER, vec FLOAT[3])");
      await db.exec(`
        INSERT INTO vecs_no_idx VALUES
          (1, [1.0, 0.0, 0.0]),
          (2, [0.0, 1.0, 0.0])
      `);

      const rows = await db.query<{ id: number }>(
        "SELECT id FROM vecs_no_idx ORDER BY array_distance(vec, [0.0, 0.9, 0.1]::FLOAT[3]) LIMIT 1",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(2);
    });
  });

  describe("prepared statements", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("closes the statement of every parameterised query", async () => {
      db = await newBrowserDuckDb();
      const close = vi.spyOn(duckdb.AsyncPreparedStatement.prototype, "close");
      await db.query("SELECT $1::INTEGER AS x", [1]);
      await db.query("SELECT $1::INTEGER AS x", [2]);
      await expect(db.query("SELECT $1::INTEGER AS x", ["not a number"])).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(3);
    });
  });

  describe("result values", () => {
    it("returns plain JS values like db-duckdb-node", async () => {
      db = await newBrowserDuckDb();
      const [row] = await db.query<Record<string, unknown>>(
        "SELECT 1.25::DECIMAL(10,2) AS d, DATE '2024-01-02' AS dt, TIMESTAMP '2024-01-02 03:04:05.123' AS ts, [1,2] AS l, {'a': 1, 'b': [2]} AS s, 5::BIGINT AS b",
      );
      expect(row).toEqual({
        d: 1.25,
        dt: new Date("2024-01-02T00:00:00.000Z"),
        ts: new Date("2024-01-02T03:04:05.123Z"),
        l: [1, 2],
        s: { a: 1, b: [2] },
        b: 5n,
      });
      expect(Array.isArray(row?.l)).toBe(true);
    });
  });

  describe("parameter binding", () => {
    it("binds a fetched BIGINT id back as a parameter", async () => {
      db = await newBrowserDuckDb();
      await db.exec("CREATE TABLE ids (id BIGINT, n VARCHAR)");
      await db.exec("INSERT INTO ids VALUES (9007199254740993, 'a'), (5, 'b')");
      const [first] = await db.query<{ id: bigint }>("SELECT id FROM ids WHERE n = 'a'");
      expect(first?.id).toBe(9007199254740993n);
      const rows = await db.query("SELECT n FROM ids WHERE id = $1", [first?.id]);
      expect(rows).toEqual([{ n: "a" }]);
    });

    it("binds a Date as a timestamp", async () => {
      db = await newBrowserDuckDb();
      await db.exec("CREATE TABLE events (ts TIMESTAMP, n VARCHAR)");
      await db.exec("INSERT INTO events VALUES (TIMESTAMP '2024-01-02 03:04:05', 'a')");
      const rows = await db.query("SELECT n FROM events WHERE ts = $1", [
        new Date("2024-01-02T03:04:05.000Z"),
      ]);
      expect(rows).toEqual([{ n: "a" }]);
    });

    it("rejects unsupported parameter types with a clear error", async () => {
      db = await newBrowserDuckDb();
      await expect(db.query("SELECT $1 AS x", [new Uint8Array([1])])).rejects.toThrow(
        /parameter \$1 of type Uint8Array/,
      );
      await expect(db.query("SELECT $1 AS x", [[1, 2]])).rejects.toThrow(
        /parameter \$1 of type array/,
      );
    });
  });

  describe("persistent path", () => {
    // Same-origin bundles, as a self-hosting app would pass: the jsDelivr
    // worker wrapped in a Blob of this page's origin.
    function sameOriginBundles(): duckdb.DuckDBBundles {
      const cdn = duckdb.getJsDelivrBundles();
      const shim = (url: string) =>
        URL.createObjectURL(new Blob([`importScripts("${url}");`], { type: "text/javascript" }));
      return {
        mvp: { mainModule: cdn.mvp.mainModule, mainWorker: shim(cdn.mvp.mainWorker as string) },
        eh: cdn.eh && {
          mainModule: cdn.eh.mainModule,
          mainWorker: shim(cdn.eh.mainWorker as string),
        },
      };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("rejects instead of falling back to memory when the path cannot be opened", async () => {
      const open = vi
        .spyOn(duckdb.AsyncDuckDB.prototype, "open")
        .mockRejectedValue(new Error("open failed"));
      const terminate = vi.spyOn(duckdb.AsyncDuckDB.prototype, "terminate");
      await expect(
        newBrowserDuckDb({ path: "opfs://broken.duckdb", bundles: sameOriginBundles() }),
      ).rejects.toThrow(/opfs:\/\/broken\.duckdb/);
      expect(open).toHaveBeenCalled();
      expect(terminate).toHaveBeenCalled();
    });

    it("terminates the engine when connect fails after a successful instantiate", async () => {
      vi.spyOn(duckdb.AsyncDuckDB.prototype, "connect").mockRejectedValue(
        new Error("connect failed"),
      );
      const terminate = vi.spyOn(duckdb.AsyncDuckDB.prototype, "terminate");
      await expect(newBrowserDuckDb()).rejects.toThrow("connect failed");
      expect(terminate).toHaveBeenCalled();
    });

    it("rejects a path without self-hosted bundles before starting a worker", async () => {
      const instantiate = vi.spyOn(duckdb.AsyncDuckDB.prototype, "instantiate");
      await expect(newBrowserDuckDb({ path: "opfs://cdn.duckdb" })).rejects.toThrow(
        /opfs:\/\/cdn\.duckdb": OPFS needs self-hosted `bundles`/,
      );
      expect(instantiate).not.toHaveBeenCalled();
    });

    it("rejects instead of falling back to memory when OPFS is unavailable", async () => {
      vi.stubGlobal("navigator", {});
      await expect(
        newBrowserDuckDb({ path: "opfs://unavailable.duckdb", bundles: sameOriginBundles() }),
      ).rejects.toThrow(/opfs:\/\/unavailable\.duckdb": OPFS is unavailable/);
    });
  });
});
