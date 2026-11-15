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
 * binds a bigint or an integer-valued number, and reads an integer above 2^53, is unprobed
 * (celld 0.6.x). Skipped only by the
 * real-DO run (`test:do`); once a celld run passes them, delete them from this list.
 */
export const DO_UNPROBED_SCENARIOS = [
  "integers above 2^53 round-trip as bigint, safe integers come back as numbers",
  "integer numbers bind as INTEGER, other numbers as REAL",
];

/**
 * `runDbConformance` scenarios the real-DO run (`test:do`) skips, because of its test harness, not
 * the driver: `remoteDb` sends every call as its own HTTP request and JSON body. Concurrent
 * requests can reach the Durable Object out of call order, so ordering and close-during-a-call
 * cannot be checked through it; JSON cannot carry a Uint8Array or a bigint. The same scenarios
 * run against the driver itself on the node:sqlite fake (`do-sqlite-db.test.ts`).
 */
export const DO_REMOTE_UNSUPPORTED_DB_SCENARIOS = [
  "close waits for an in-flight query, then closes",
  "calls made after close has started reject with 'the database is closed'",
  "concurrent calls run in call order",
  "a BLOB parameter round-trips as a Uint8Array",
  "integers come back as numbers when safe and as bigints beyond 2^53",
];
