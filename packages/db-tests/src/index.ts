/**
 * @statewalker/db-tests
 *
 * Shared, parametrized conformance suite for `@statewalker/db-api`
 * implementations. Node-only — consumed by the db-* node adapter tests via
 * `runDbConformance(makeDb, { placeholder, normalizeRow? })`.
 */

export * from "./suites/index.js";
