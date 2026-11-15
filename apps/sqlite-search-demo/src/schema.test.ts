import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RESET_SQL, SCHEMA } from "./schema.js";

function seed(db: DatabaseSync): void {
  const insert = db.prepare("INSERT INTO docs (id, title, body, embedding) VALUES (?, ?, ?, ?)");
  insert.run(1, "SQLite basics", "SQLite is a compact embedded database.", new Uint8Array(4));
  insert.run(
    2,
    "Semantic search",
    "Vector similarity finds meaning-based matches.",
    new Uint8Array(4),
  );
}

function score(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT bm25(docs_fts) AS s FROM docs_fts WHERE docs_fts MATCH 'sqlite'")
    .get() as { s: number };
  return row.s;
}

describe("demo schema", () => {
  it("keeps the FTS5 index intact across repeated resets", () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of SCHEMA) db.exec(sql);
    seed(db);
    const first = score(db);
    for (let i = 0; i < 3; i++) {
      db.exec(RESET_SQL);
      seed(db);
      expect(() =>
        db.exec("INSERT INTO docs_fts(docs_fts) VALUES('integrity-check')"),
      ).not.toThrow();
      expect(score(db)).toBeCloseTo(first, 10);
    }
    db.close();
  });

  it("follows an update of a row", () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of SCHEMA) db.exec(sql);
    seed(db);
    db.exec("UPDATE docs SET body = 'nothing relevant here' WHERE id = 1");
    db.exec("UPDATE docs SET title = 'renamed' WHERE id = 1");
    expect(() => db.exec("INSERT INTO docs_fts(docs_fts) VALUES('integrity-check')")).not.toThrow();
    const hits = db.prepare("SELECT rowid FROM docs_fts WHERE docs_fts MATCH 'compact'").all();
    expect(hits).toEqual([]);
    db.close();
  });
});
