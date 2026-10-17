import { sqliteTransactionScenarios } from "@statewalker/db-tests/sqlite-transaction-scenarios";

/**
 * Every scenario the real-DO suite runs. Other packages of this repository append their smoke
 * scenarios here by relative import of a file in their own src/ (no package dependency: that
 * would be a workspace cycle). Names must be unique.
 */
export const SCENARIOS = [...sqliteTransactionScenarios];
