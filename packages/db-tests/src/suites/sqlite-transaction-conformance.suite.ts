import type { Db } from "@statewalker/db-api";
import { describe, it } from "vitest";
import { sqliteTransactionScenarios } from "./sqlite-transaction-scenarios.js";

/**
 * Register every SQLite transaction scenario for one driver; `makeDb` returns a fresh, empty Db.
 * `skip` names scenarios the driver's platform cannot meet.
 */
export function runSqliteTransactionConformance(
  makeDb: () => Promise<Db>,
  { skip = [] }: { skip?: string[] } = {},
): void {
  describe("SQLite transaction conformance", () => {
    for (const scenario of sqliteTransactionScenarios.filter((s) => !skip.includes(s.name))) {
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
