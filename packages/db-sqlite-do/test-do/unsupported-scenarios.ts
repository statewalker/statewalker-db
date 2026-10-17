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
