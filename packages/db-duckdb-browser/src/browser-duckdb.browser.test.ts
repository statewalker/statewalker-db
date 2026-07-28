import type { Db } from "@statewalker/db-api";
import { runDbConformance } from "@statewalker/db-tests";
import { afterEach, describe, expect, it } from "vitest";
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
});
