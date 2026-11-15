/**
 * The demo's tables. `docs_fts` is an external-content FTS5 index over `docs`: SQLite does not
 * update it by itself, so triggers mirror every insert, delete and update. Without the delete
 * trigger, "Reset demo data" left the old postings behind and corrupted the index
 * (statewalker-db#38).
 */
export const SCHEMA = [
  `CREATE TABLE docs (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    embedding BLOB NOT NULL
  )`,
  `CREATE VIRTUAL TABLE docs_fts USING fts5(
    title,
    body,
    content='docs',
    content_rowid='id'
  )`,
  `CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END`,
  `CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  END`,
  `CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END`,
];

/** Empties the demo data; the delete trigger removes the matching postings. */
export const RESET_SQL = "DELETE FROM docs";
