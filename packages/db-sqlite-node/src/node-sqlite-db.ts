import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db, DbOptions } from "@statewalker/db-api";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";

/**
 * Create a SQLite {@link Db} on Node.js's built-in `node:sqlite`.
 *
 * @param options.path  Database file. Omit for an in-memory database.
 */
export async function newNodeSqliteDb(options?: DbOptions): Promise<Db> {
  const db = new DatabaseSync(options?.path ?? ":memory:");
  return newSerialisedSqliteDb({
    all: (sql, params) => {
      // Integers as bigint, so one above 2^53 is read exactly; db-sqlite turns safe ones into numbers.
      const statement = db.prepare(sql);
      statement.setReadBigInts(true);
      return statement.all(...(params as SQLInputValue[])) as Record<string, unknown>[];
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
}
