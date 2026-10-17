import { sqliteTransactionScenarios } from "@statewalker/db-tests/sqlite-transaction-scenarios";
import { vectorDoScenarios } from "../../db-sqlite-index/src/vector/do-smoke.js";
import { DO_UNSUPPORTED_SCENARIOS } from "./unsupported-scenarios.js";

/**
 * Every scenario the real-DO suite runs. Other packages of this repository append their smoke
 * scenarios here by relative import of a file in their own src/ (no package dependency: that
 * would be a workspace cycle). Names must be unique.
 */
export const SCENARIOS = [
  ...sqliteTransactionScenarios.filter((s) => !DO_UNSUPPORTED_SCENARIOS.includes(s.name)),
  ...vectorDoScenarios,
];
