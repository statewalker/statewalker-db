import type { Db } from "@statewalker/db-api";
import { describe, it } from "vitest";
import { sqliteTransactionScenarios } from "./sqlite-transaction-scenarios.js";

/** Register every SQLite transaction scenario for one driver; `makeDb` returns a fresh, empty Db. */
export function runSqliteTransactionConformance(makeDb: () => Promise<Db>): void {
  describe("SQLite transaction conformance", () => {
    for (const scenario of sqliteTransactionScenarios) {
      it(scenario.name, async () => {
        const db = await makeDb();
        try {
          await scenario.run(db);
        } finally {
          await db.close();
        }
      });
    }
  });
}
