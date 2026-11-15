/**
 * Transaction scenarios a Durable Object cannot meet, skipped on the fake and on real DO alike.
 * "the callback's error survives a rollback SQLite already performed": when SQLite itself ends the
 * transaction (ON CONFLICT ROLLBACK), the platform's own ROLLBACK fails and the whole DO call
 * rejects with "cannot rollback - no transaction is active" (celld 0.6.2), so the callback's
 * error cannot survive. The fake reproduces this; see do-sqlite-db.test.ts.
 * "a COMMIT that fails on a deferred foreign key rolls back and rejects": the scenario needs
 * `PRAGMA foreign_keys = ON`, and a Durable Object rejects PRAGMA ("not authorized").
 */
export const DO_UNSUPPORTED_SCENARIOS = [
  "the callback's error survives a rollback SQLite already performed",
  "a COMMIT that fails on a deferred foreign key rolls back and rejects",
];

/**
 * Scenarios the fake meets but real DO SQLite has not been checked against yet: how the platform
 * binds a bigint and reads an integer above 2^53 is unprobed (celld 0.6.x). Skipped only by the
 * real-DO run (`test:do`); once a celld run passes them, delete them from this list.
 */
export const DO_UNPROBED_SCENARIOS = [
  "integers above 2^53 round-trip as bigint, safe integers come back as numbers",
];
