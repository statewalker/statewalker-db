import type { GramBackend, NgramItem } from "./fts5-backend.js";
import { chunkJson } from "./json-chunks.js";
import { encodeGram, gramsOf, trigrams } from "./trigrams.js";

const PAIR = "json_extract(value, '$[0]'), json_extract(value, '$[1]')";

/**
 * One row per (gram, id) in a WITHOUT ROWID table: the primary key is the
 * posting list, clustered by gram. A text is a candidate for a branch when it
 * holds every distinct gram of the branch's literals.
 */
export function newPostingsBackend(prefix: string): GramBackend {
  const table = `${prefix}grams`;
  const pairs = (items: NgramItem[]) =>
    chunkJson(
      items.flatMap((item) => trigrams(item.text).map((gram) => [encodeGram(gram), item.id])),
    );
  return {
    create: (tx) =>
      tx.exec(
        `CREATE TABLE IF NOT EXISTS ${table}(gram INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (gram, id)) WITHOUT ROWID`,
      ),
    async add(tx, items) {
      for (const chunk of pairs(items)) {
        await tx.query(
          `INSERT OR IGNORE INTO ${table}(gram, id) SELECT ${PAIR} FROM json_each(?)`,
          [chunk],
        );
      }
    },
    async remove(tx, items) {
      for (const chunk of pairs(items)) {
        await tx.query(
          `DELETE FROM ${table} WHERE (gram, id) IN (SELECT ${PAIR} FROM json_each(?))`,
          [chunk],
        );
      }
    },
    async candidates(db, branches, max) {
      const ids = new Set<number>();
      for (const branch of branches) {
        // Literals are already folded: split them without folding again.
        const grams = [...new Set(branch.flatMap((literal) => gramsOf(literal).map(encodeGram)))];
        const rows = await db.query<{ id: number }>(
          `SELECT id FROM ${table} WHERE gram IN (SELECT value FROM json_each(?)) GROUP BY id HAVING count(*) = ? ORDER BY id LIMIT ?`,
          [JSON.stringify(grams), grams.length, max],
        );
        for (const row of rows) ids.add(Number(row.id));
      }
      return [...ids].sort((a, b) => a - b).slice(0, max);
    },
  };
}
