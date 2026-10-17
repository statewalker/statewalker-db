import type { Db } from "@statewalker/db-api";
import { runDbConformance, runSqliteTransactionConformance } from "@statewalker/db-tests";
import { afterEach, describe, expect, it } from "vitest";
import { newBrowserSqliteDb } from "./browser-sqlite-db.js";

/**
 * The sqlite-wasm adapter, exercised in a REAL browser (Vitest browser
 * mode + Playwright/Chromium). Launched only by `vitest.browser.config.ts` (the
 * `test:browser` script) — the Node config excludes `*.browser.test.ts`.
 *
 * Everything runs in-memory except the OPFS tests, which use Dedicated Workers;
 * the node-only file-persistence scenario is skipped via `skipFilePersistence`.
 */

runDbConformance(() => newBrowserSqliteDb(), { placeholder: "?", skipFilePersistence: true });
runSqliteTransactionConformance(() => newBrowserSqliteDb());

// Dialect-specific browser behavior the shared suite does not cover: FTS5 full-text search.
describe("newBrowserSqliteDb", () => {
  let db: Db;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe("FTS5", () => {
    it("has the trigram tokenizer (substring search)", async () => {
      db = await newBrowserSqliteDb();
      await db.exec("CREATE VIRTUAL TABLE g USING fts5(c, tokenize='trigram')");
      await db.exec("INSERT INTO g VALUES ('idx_lefthand')");
      const rows = await db.query<{ c: string }>("SELECT c FROM g WHERE g MATCH 'x_le'");
      expect(rows.map((r) => r.c)).toEqual(["idx_lefthand"]);
    });

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
});

type TestWorker = {
  onmessage: ((event: { data: { count?: number; error?: string } }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
};
const WorkerClass = (
  globalThis as unknown as {
    Worker: new (url: URL, options: { type: "module" }) => TestWorker;
  }
).Worker;

/** Run one action in a fresh Dedicated Worker, then terminate it (as a page reload would). */
function inWorker(
  message:
    | { path: string; action: "write" | "count" }
    | { path: string; action: "open-many"; files: number; capacity?: number },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(new URL("../test/opfs-test-worker.ts", import.meta.url), {
      type: "module",
    });
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
    await expect(newBrowserSqliteDb({ path: "/main-thread.db" })).rejects.toThrow(
      /Dedicated Worker/,
    );
  });

  it("keeps a path's data from one worker to the next", async () => {
    const path = `/persist-${Date.now()}.db`;
    expect(await inWorker({ path, action: "write" })).toBe(1);
    expect(await inWorker({ path, action: "count" })).toBe(1);
  });

  // Order matters: the pool's capacity is stored in OPFS and only grows, so the default-size
  // case must run before any test raises it. Files stay in the pool after close, so the
  // second case leaves room for the ones the first left behind.
  it("runs out of pool files with the default capacity", async () => {
    const path = `/full-${Date.now()}`;
    await expect(inWorker({ path, action: "open-many", files: 10 })).rejects.toThrow(
      /SQLITE_CANTOPEN/,
    );
  });

  it("opens more databases once capacity is raised", async () => {
    const path = `/many-${Date.now()}`;
    expect(await inWorker({ path, action: "open-many", files: 10, capacity: 32 })).toBe(10);
  });
});
