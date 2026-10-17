import type { Db } from "@statewalker/db-api";
import { fold } from "./fold.js";
import { chunkJson } from "./json-chunks.js";

export type NgramItem = { id: number; text: string };

/** How one store finds candidate ids; texts and verification live in NgramStore. */
export type GramBackend = {
  create(tx: Db): Promise<void>;
  add(tx: Db, items: NgramItem[]): Promise<void>;
  /** `items` hold the texts as currently stored, so their grams can be removed exactly. */
  remove(tx: Db, items: NgramItem[]): Promise<void>;
  /** Ids whose text contains every literal of at least one branch; ascending, at most `max`. */
  candidates(db: Db, branches: string[][], max: number): Promise<number[]>;
};

const ROW = "json_extract(value, '$[0]'), json_extract(value, '$[1]')";

/**
 * FTS5 trigram over folded text. Contentless (`content=''`), because NgramStore
 * already keeps the text; a contentless row is deleted by replaying its exact
 * indexed value through the 'delete' command, which is why `remove` needs the
 * stored texts. `case_sensitive 1`: folding is done by `fold`, the same function
 * that folds query literals, so the index and the planner can never disagree.
 */
export function newFts5Backend(prefix: string): GramBackend {
  const table = `${prefix}ng`;
  const write = async (tx: Db, items: NgramItem[], command: "insert" | "delete") => {
    const sql =
      command === "insert"
        ? `INSERT INTO ${table}(rowid, text) SELECT ${ROW} FROM json_each(?)`
        : `INSERT INTO ${table}(${table}, rowid, text) SELECT 'delete', ${ROW} FROM json_each(?)`;
    for (const chunk of chunkJson(items.map((item) => [item.id, fold(item.text)]))) {
      await tx.query(sql, [chunk]);
    }
  };
  return {
    create: (tx) =>
      tx.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(text, content='', tokenize='trigram case_sensitive 1')`,
      ),
    add: (tx, items) => write(tx, items, "insert"),
    remove: (tx, items) => write(tx, items, "delete"),
    async candidates(db, branches, max) {
      // A quoted string is a phrase of consecutive trigrams, i.e. an exact substring.
      const quote = (literal: string) => `"${literal.replaceAll('"', '""')}"`;
      const match = branches.map((branch) => `(${branch.map(quote).join(" AND ")})`).join(" OR ");
      const rows = await db.query<{ id: number }>(
        `SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid LIMIT ?`,
        [match, max],
      );
      return rows.map((row) => Number(row.id));
    },
  };
}
