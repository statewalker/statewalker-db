import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";
import { runSqliteTransactionConformance } from "./sqlite-transaction-conformance.suite.js";

runSqliteTransactionConformance(async () => {
  const db = new DatabaseSync(":memory:");
  return newSerialisedSqliteDb({
    all: (sql, params) => {
      // Integers as bigint, so one above 2^53 is read exactly; db-sqlite turns safe ones into numbers.
      const statement = db.prepare(sql);
      statement.setReadBigInts(true);
      const bound = params.map((v) =>
        typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : (v as SQLInputValue),
      );
      return statement.all(...bound) as Record<string, unknown>[];
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
});
