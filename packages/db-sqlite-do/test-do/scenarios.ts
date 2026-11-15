import { sqliteTransactionScenarios } from "@statewalker/db-tests/sqlite-transaction-scenarios";
import { DO_UNPROBED_SCENARIOS, DO_UNSUPPORTED_SCENARIOS } from "./unsupported-scenarios.js";

/**
 * Every scenario the real-DO suite runs: the SQLite transaction scenarios a DO can meet. Packages
 * built on this driver run their own smoke scenarios in their own `test:do` (db-sqlite-index's
 * test-do/), so this package depends on none of them. Names must be unique.
 */
export const SCENARIOS = sqliteTransactionScenarios.filter(
  (s) => !DO_UNSUPPORTED_SCENARIOS.includes(s.name) && !DO_UNPROBED_SCENARIOS.includes(s.name),
);
