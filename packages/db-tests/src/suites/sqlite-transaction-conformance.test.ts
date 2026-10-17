import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";
import { runSqliteTransactionConformance } from "./sqlite-transaction-conformance.suite.js";

runSqliteTransactionConformance(async () => {
  const db = new DatabaseSync(":memory:");
  return newSerialisedSqliteDb({
    all: (sql, params) =>
      db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[],
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
});
