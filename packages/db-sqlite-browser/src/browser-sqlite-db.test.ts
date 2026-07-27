import type { Db } from "@statewalker/db-api";
import { afterEach, describe, expect, it } from "vitest";
import { newBrowserSqliteDb } from "./browser-sqlite-db.js";

/**
 * Browser-based SQLite tests are skipped in Node.js environments.
 * They require a real browser with WASM support.
 *
 * To run these tests in a browser, use vitest with `@vitest/browser` and Playwright:
 *   vitest --browser.name=chromium
 */
describe.skip("newBrowserSqliteDb (requires browser environment)", () => {
  let db: Db;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe("basic CRUD", () => {
    it("creates a table, inserts rows, and queries them", async () => {
      db = await newBrowserSqliteDb();
      await db.exec("CREATE TABLE users (id INTEGER, name TEXT, age INTEGER)");
      await db.exec("INSERT INTO users VALUES (1, 'Alice', 30), (2, 'Bob', 25)");

      const rows = await db.query<{ id: number; name: string; age: number }>(
        "SELECT * FROM users ORDER BY id",
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: 1, name: "Alice", age: 30 });
      expect(rows[1]).toMatchObject({ id: 2, name: "Bob", age: 25 });
    });

    it("supports parameterized queries", async () => {
      db = await newBrowserSqliteDb();
      await db.exec("CREATE TABLE items (id INTEGER, label TEXT)");
      await db.exec("INSERT INTO items VALUES (1, 'one'), (2, 'two'), (3, 'three')");

      const rows = await db.query<{ id: number; label: string }>(
        "SELECT * FROM items WHERE id = ?",
        [2],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 2, label: "two" });
    });
  });

  describe("close", () => {
    it("closes without error", async () => {
      db = await newBrowserSqliteDb();
      await db.exec("SELECT 1");
      await expect(db.close()).resolves.toBeUndefined();
    });
  });

  describe("FTS5", () => {
    it("returns empty results for unmatched search terms", async () => {
      db = await newBrowserSqliteDb();
      await db.exec("CREATE VIRTUAL TABLE docs2_fts USING fts5(content)");
      await db.exec(
        "INSERT INTO docs2_fts (rowid, content) VALUES (1, 'hello world'), (2, 'goodbye world')",
      );

      const rows = await db.query<{ content: string }>(
        "SELECT content FROM docs2_fts WHERE docs2_fts MATCH 'nonexistent'",
      );
      expect(rows).toHaveLength(0);
    });

    it("searches across multiple text columns", async () => {
      db = await newBrowserSqliteDb();
      await db.exec("CREATE VIRTUAL TABLE articles_fts USING fts5(title, body, tokenize='porter')");
      await db.exec(`
        INSERT INTO articles_fts (rowid, title, body) VALUES
          (1, 'Travel Guide', 'Visit the beautiful lakes of Switzerland'),
          (2, 'Cooking Tips', 'How to make a perfect lake trout'),
          (3, 'Programming', 'Learn about SQL databases')
      `);

      const rows = await db.query<{ rowid: number; title: string; score: number }>(`
        SELECT rowid, title, bm25(articles_fts) AS score
        FROM articles_fts
        WHERE articles_fts MATCH 'lake'
        ORDER BY score
      `);
      expect(rows).toHaveLength(2);
      const titles = rows.map((r) => r.title);
      expect(titles).toContain("Travel Guide");
      expect(titles).toContain("Cooking Tips");
    });

    it("creates an FTS5 index and performs full-text search", async () => {
      db = await newBrowserSqliteDb();
      await db.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(content)");
      await db.exec(`
        INSERT INTO docs_fts (rowid, content) VALUES
          (1, 'the quick brown fox jumps over the lazy dog'),
          (2, 'a lazy cat sleeps on the mat'),
          (3, 'the fox and the hound are friends')
      `);

      const rows = await db.query<{ rowid: number; content: string; score: number }>(`
        SELECT rowid, content, bm25(docs_fts) AS score
        FROM docs_fts
        WHERE docs_fts MATCH 'fox'
        ORDER BY score
      `);

      expect(rows.length).toBeGreaterThanOrEqual(1);
      const rowids = rows.map((r) => r.rowid);
      expect(rowids).toContain(1);
      expect(rowids).toContain(3);
    });
  });

  describe("vector search", () => {
    it("creates index and performs vector similarity search", async () => {
      db = await newBrowserSqliteDb();

      await db.exec("CREATE TABLE embeddings (id INTEGER PRIMARY KEY, vec F32_BLOB(3))");
      await db.exec("CREATE INDEX vec_idx ON embeddings (libsql_vector_idx(vec))");
      await db.exec(`
        INSERT INTO embeddings VALUES
          (1, vector32('[1.0, 0.0, 0.0]')),
          (2, vector32('[0.0, 1.0, 0.0]')),
          (3, vector32('[0.0, 0.0, 1.0]'))
      `);

      const rows = await db.query<{ id: number }>(
        "SELECT e.id FROM vector_top_k('vec_idx', '[1.0, 0.1, 0.0]', 1) AS v JOIN embeddings e ON e.rowid = v.id",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(1);
    });

    it("returns k nearest neighbors ordered by distance", async () => {
      db = await newBrowserSqliteDb();

      await db.exec("CREATE TABLE vectors (id INTEGER PRIMARY KEY, vec F32_BLOB(3))");
      await db.exec("CREATE INDEX vec_idx2 ON vectors (libsql_vector_idx(vec))");
      await db.exec(`
        INSERT INTO vectors VALUES
          (1, vector32('[1.0, 0.0, 0.0]')),
          (2, vector32('[0.9, 0.1, 0.0]')),
          (3, vector32('[0.0, 1.0, 0.0]')),
          (4, vector32('[0.0, 0.0, 1.0]'))
      `);

      const rows = await db.query<{ id: number }>(
        "SELECT e.id FROM vector_top_k('vec_idx2', '[1.0, 0.0, 0.0]', 2) AS v JOIN vectors e ON e.rowid = v.id",
      );

      expect(rows).toHaveLength(2);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(1);
      expect(ids).toContain(2);
    });

    it("works without index (brute-force scan)", async () => {
      db = await newBrowserSqliteDb();

      await db.exec("CREATE TABLE vecs_no_idx (id INTEGER PRIMARY KEY, vec F32_BLOB(3))");
      await db.exec(`
        INSERT INTO vecs_no_idx VALUES
          (1, vector32('[1.0, 0.0, 0.0]')),
          (2, vector32('[0.0, 1.0, 0.0]'))
      `);

      const rows = await db.query<{ id: number }>(
        "SELECT id FROM vecs_no_idx ORDER BY vector_distance_cos(vec, vector32('[0.0, 0.9, 0.1]')) LIMIT 1",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(2);
    });
  });
});

describe("browser-sqlite-db module", () => {
  it("exports newBrowserSqliteDb function", async () => {
    const mod = await import("./browser-sqlite-db.js");
    expect(typeof mod.newBrowserSqliteDb).toBe("function");
  });
});
