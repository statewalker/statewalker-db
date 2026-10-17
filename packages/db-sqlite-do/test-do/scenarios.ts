import { sqliteTransactionScenarios } from "@statewalker/db-tests/sqlite-transaction-scenarios";

/**
 * Transaction scenarios a Durable Object cannot meet, skipped on the fake and on real DO alike.
 * "the callback's error survives a rollback SQLite already performed": when SQLite itself ends the
 * transaction (ON CONFLICT ROLLBACK), the platform's own ROLLBACK fails and the whole DO call
 * rejects with "cannot rollback - no transaction is active" (celld 0.6.2), so the callback's
 * error cannot survive. The fake reproduces this; see do-sqlite-db.test.ts.
 */
export const DO_UNSUPPORTED_SCENARIOS = [
  "the callback's error survives a rollback SQLite already performed",
];

/**
 * Every scenario the real-DO suite runs. Other packages of this repository append their smoke
 * scenarios here by relative import of a file in their own src/ (no package dependency: that
 * would be a workspace cycle). Names must be unique.
 */
export const SCENARIOS = sqliteTransactionScenarios.filter(
  (s) => !DO_UNSUPPORTED_SCENARIOS.includes(s.name),
);
