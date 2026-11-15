import type { Db } from "@statewalker/db-api";
import { runDbConformance } from "@statewalker/db-tests";
import { afterEach, describe, expect, it } from "vitest";
import { newNodeDuckDb } from "./node-duckdb.js";

// Common contract (CRUD, parameter binding, cardinality, close, file
// persistence, error paths) is covered by the shared conformance suite.
// duckdb dialect: `$1` placeholder; rows are already plain, so the spread
// normalizer is an identity-style copy.
runDbConformance(newNodeDuckDb, {
  placeholder: "$1",
  normalizeRow: (row) => ({ ...row }),
});

// Dialect-specific behavior kept per-adapter: DuckDB FTS extension + VSS/HNSW.
describe("newNodeDuckDb", () => {
  let db: Db;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe("parameter types", () => {
    it("round-trips a Uint8Array through a BLOB column", async () => {
      db = await newNodeDuckDb();
      await db.exec("CREATE TABLE b (id INTEGER, x BLOB)");
      await db.query("INSERT INTO b VALUES ($1, $2)", [1, new Uint8Array([0, 1, 2, 255])]);
      const rows = await db.query<{ x: Uint8Array }>("SELECT x FROM b WHERE id = $1", [1]);
      expect(Array.from(rows[0]?.x ?? [])).toEqual([0, 1, 2, 255]);
      const found = await db.query<{ id: number }>("SELECT id FROM b WHERE x = $1", [
        new Uint8Array([0, 1, 2, 255]),
      ]);
      expect(found).toEqual([{ id: 1 }]);
    });

    it("binds a Date into a TIMESTAMP column", async () => {
      db = await newNodeDuckDb();
      await db.exec("CREATE TABLE t (d TIMESTAMP)");
      const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
      await db.query("INSERT INTO t VALUES ($1)", [date]);
      const rows = await db.query<{ d: Date; y: number }>("SELECT d, year(d)::INTEGER AS y FROM t");
      expect(rows[0]?.d).toBeInstanceOf(Date);
      expect(rows[0]?.d.getTime()).toBe(date.getTime());
      expect(rows[0]?.y).toBe(2024);
    });

    it("binds a Date into a TIMESTAMPTZ column as the same instant, whatever the time zone", async () => {
      db = await newNodeDuckDb();
      // A TIMESTAMP cast to TIMESTAMPTZ is read in the session time zone: not UTC here.
      await db.exec("SET TimeZone = 'America/New_York'");
      await db.exec("CREATE TABLE tz (d TIMESTAMPTZ)");
      const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
      await db.query("INSERT INTO tz VALUES ($1)", [date]);
      const rows = await db.query<{ ms: bigint | number }>("SELECT epoch_ms(d) AS ms FROM tz");
      expect(Number(rows[0]?.ms)).toBe(date.getTime());
      const found = await db.query("SELECT 1 AS hit FROM tz WHERE d = $1", [date]);
      expect(found).toHaveLength(1);
    });

    it("binds Dates inside a list into TIMESTAMPTZ[] as the same instants", async () => {
      db = await newNodeDuckDb();
      await db.exec("SET TimeZone = 'America/New_York'");
      await db.exec("CREATE TABLE ta (x TIMESTAMPTZ[])");
      const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
      await db.query("INSERT INTO ta VALUES ($1)", [[date, date]]);
      const rows = await db.query<{ ms: bigint | number }>("SELECT epoch_ms(x[2]) AS ms FROM ta");
      expect(Number(rows[0]?.ms)).toBe(date.getTime());
      const cast = await db.query<{ ms: bigint | number }>(
        "SELECT epoch_ms(($1::TIMESTAMPTZ[])[1]) AS ms",
        [[date]],
      );
      expect(Number(cast[0]?.ms)).toBe(date.getTime());
    });

    it("still binds ISO strings into TIMESTAMPTZ[]", async () => {
      db = await newNodeDuckDb();
      const rows = await db.query<{ ms: bigint | number }>(
        "SELECT epoch_ms(($1::TIMESTAMPTZ[])[1]) AS ms",
        [["2024-01-02T03:04:05.678Z"]],
      );
      expect(Number(rows[0]?.ms)).toBe(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
    });

    it("rejects an invalid Date with a clear error", async () => {
      db = await newNodeDuckDb();
      await expect(db.query("SELECT $1::TIMESTAMP AS d", [new Date(Number.NaN)])).rejects.toThrow(
        /Invalid Date/,
      );
    });

    it("binds a JS array into a FLOAT[3] column and searches by vector", async () => {
      db = await newNodeDuckDb();
      await db.exec("CREATE TABLE e (id INTEGER, vec FLOAT[3])");
      await db.query("INSERT INTO e VALUES ($1, $2)", [1, [1, 0, 0]]);
      await db.query("INSERT INTO e VALUES ($1, $2)", [2, new Float32Array([0, 1, 0])]);
      const rows = await db.query<{ id: number }>(
        "SELECT id FROM e ORDER BY array_distance(vec, $1::FLOAT[3]) LIMIT 1",
        [[0, 0.9, 0.1]],
      );
      expect(rows).toEqual([{ id: 2 }]);
      const vecs = await db.query<{ vec: number[] }>("SELECT vec FROM e ORDER BY id");
      expect(vecs.map((r) => r.vec)).toEqual([
        [1, 0, 0],
        [0, 1, 0],
      ]);
    });

    it("binds JS arrays, nested and empty, into INTEGER[] columns", async () => {
      db = await newNodeDuckDb();
      await db.exec("CREATE TABLE l (id INTEGER, xs INTEGER[], xss INTEGER[][])");
      await db.query("INSERT INTO l VALUES ($1, $2, $3)", [1, [1, 2, 3], [[1], [2, 3]]]);
      await db.query("INSERT INTO l (id, xs) VALUES ($1, $2)", [2, []]);
      const rows = await db.query<{ id: number; xs: number[]; xss: number[][] | null }>(
        "SELECT id, xs, xss FROM l ORDER BY id",
      );
      expect(rows).toEqual([
        { id: 1, xs: [1, 2, 3], xss: [[1], [2, 3]] },
        { id: 2, xs: [], xss: null },
      ]);
    });
  });

  describe("list item types", () => {
    it("infers list types from all items, not only the first", async () => {
      db = await newNodeDuckDb();
      const rows = await db.query<{ d: number[]; b: bigint[]; s: string[]; n: number[] }>(
        "SELECT $1 AS d, $2 AS b, $3 AS s, $4 AS n",
        [
          [0, 0.5],
          [1, 3_000_000_000],
          ["a", "b"],
          [null, 1],
        ],
      );
      expect(rows[0]?.d).toEqual([0, 0.5]);
      expect(rows[0]?.b).toEqual([1n, 3_000_000_000n]);
      expect(rows[0]?.s).toEqual(["a", "b"]);
      expect(rows[0]?.n).toEqual([null, 1]);
    });
  });

  describe("statements", () => {
    it("rejects several statements in one query", async () => {
      db = await newNodeDuckDb();
      await expect(db.query("SELECT 1 AS a; SELECT 2 AS b")).rejects.toThrow(/one statement/);
      await expect(db.query("SELECT $1 AS a; SELECT 2 AS b", [1])).rejects.toThrow(/one statement/);
    });

    it("still runs a single statement with a trailing semicolon or comment", async () => {
      db = await newNodeDuckDb();
      expect(await db.query("SELECT 1 AS a; -- done")).toEqual([{ a: 1 }]);
      expect(await db.query("SELECT $1::INTEGER AS a;", [2])).toEqual([{ a: 2 }]);
    });
  });

  describe("FTS extension", () => {
    it("returns empty results for unmatched search terms", async () => {
      db = await newNodeDuckDb();
      await db.exec("INSTALL fts");
      await db.exec("LOAD fts");
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
      db = await newNodeDuckDb();
      await db.exec("INSTALL fts");
      await db.exec("LOAD fts");
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
      db = await newNodeDuckDb();

      await db.exec("INSTALL fts");
      await db.exec("LOAD fts");

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
      db = await newNodeDuckDb();

      await db.exec("INSTALL vss");
      await db.exec("LOAD vss");

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
      db = await newNodeDuckDb();
      await db.exec("INSTALL vss");
      await db.exec("LOAD vss");

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
      db = await newNodeDuckDb();
      await db.exec("INSTALL vss");
      await db.exec("LOAD vss");

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
