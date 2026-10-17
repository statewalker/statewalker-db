import type { Db } from "@statewalker/db-api";
import { runDbConformance, runSqliteTransactionConformance } from "@statewalker/db-tests";
import { afterEach, describe, expect, it } from "vitest";
import { newNodeSqliteDb } from "./node-sqlite-db.js";

// Common contract and SQLite transactions come from the shared suites; FTS5 stays here.
runDbConformance(newNodeSqliteDb, { placeholder: "?" });
runSqliteTransactionConformance(() => newNodeSqliteDb());

// Engine-specific behaviour kept per driver: FTS5 with the default, porter and trigram tokenizers.
describe("newNodeSqliteDb", () => {
  let db: Db;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe("FTS5", () => {
    it("has the trigram tokenizer (substring search)", async () => {
      db = await newNodeSqliteDb();
      await db.exec("CREATE VIRTUAL TABLE g USING fts5(c, tokenize='trigram')");
      await db.exec("INSERT INTO g VALUES ('idx_lefthand')");
      const rows = await db.query<{ c: string }>("SELECT c FROM g WHERE g MATCH 'x_le'");
      expect(rows.map((r) => r.c)).toEqual(["idx_lefthand"]);
    });

    it("returns empty results for unmatched search terms", async () => {
      db = await newNodeSqliteDb();
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
      db = await newNodeSqliteDb();
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
      db = await newNodeSqliteDb();
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
});
