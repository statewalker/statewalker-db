import type { Db } from "@statewalker/db-api";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Browser-based DuckDB tests are skipped in Node.js environments.
 * They require a real browser with Worker and (optionally) OPFS support.
 *
 * To run these tests in a browser, use vitest with `@vitest/browser` and Playwright:
 *   vitest --browser.name=chromium
 */
describe.skip("newBrowserDuckDb (requires browser environment)", () => {
  let db: Db;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe("basic CRUD", () => {
    it("creates a table, inserts rows, and queries them", async () => {
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
      db = await newBrowserDuckDb();
      await db.exec("CREATE TABLE users (id INTEGER, name VARCHAR, age INTEGER)");
      await db.exec("INSERT INTO users VALUES (1, 'Alice', 30), (2, 'Bob', 25)");

      const rows = await db.query<{ id: number; name: string; age: number }>(
        "SELECT * FROM users ORDER BY id",
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ id: 1, name: "Alice", age: 30 });
      expect(rows[1]).toEqual({ id: 2, name: "Bob", age: 25 });
    });

    it("supports parameterized queries", async () => {
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
      db = await newBrowserDuckDb();
      await db.exec("CREATE TABLE items (id INTEGER, label VARCHAR)");
      await db.exec("INSERT INTO items VALUES (1, 'one'), (2, 'two'), (3, 'three')");

      const rows = await db.query<{ id: number; label: string }>(
        "SELECT * FROM items WHERE id = $1",
        [2],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ id: 2, label: "two" });
    });
  });

  describe("close", () => {
    it("closes without error", async () => {
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
      db = await newBrowserDuckDb();
      await db.exec("SELECT 1");
      await expect(db.close()).resolves.toBeUndefined();
    });
  });

  describe("FTS extension", () => {
    it("returns empty results for unmatched search terms", async () => {
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
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
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
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
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
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
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
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
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
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
      const { newBrowserDuckDb } = await import("./browser-duckdb.js");
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
});

describe("browser-duckdb module", () => {
  it("exports newBrowserDuckDb function", async () => {
    const mod = await import("./browser-duckdb.js");
    expect(typeof mod.newBrowserDuckDb).toBe("function");
  });
});
