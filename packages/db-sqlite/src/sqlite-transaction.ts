import type { Db } from "@statewalker/db-api";

/** Key under which a SQLite Db carries its transaction hook. Shared across bundles via Symbol.for. */
export const SQLITE_TRANSACTION: unique symbol = Symbol.for("@statewalker/db-sqlite:transaction");

/**
 * Key under which a SQLite Db carries its read-only transaction hook (a separate key, so that a Db
 * from an older db-sqlite, which has only the committing hook, is refused rather than committed).
 */
export const SQLITE_READ_ONLY_TRANSACTION: unique symbol = Symbol.for(
  "@statewalker/db-sqlite:read-only-transaction",
);

/** Runs `cb` inside one transaction of the Db that carries it. */
export type SqliteTransactionHook = <T>(cb: (tx: Db) => Promise<T>) => Promise<T>;

const NO_HOOK =
  "inTransaction: this Db has no SQLite transaction hook. It is not a @statewalker/db-sqlite* Db, " +
  "or it wraps one (a wrapper object loses the hook - pass the driver's Db itself), " +
  "or it is the handle of a running transaction (nesting is not supported).";

/**
 * Run `cb` in one SQLite transaction: every statement issued through `tx` commits together, or
 * none does if `cb` throws. Other calls on `db` wait until the transaction ends. `cb` must not do
 * external I/O and must be idempotent: a Durable Object may run it more than once.
 */
export function inTransaction<T>(db: Db, cb: (tx: Db) => Promise<T>): Promise<T> {
  const hook = (db as { [SQLITE_TRANSACTION]?: SqliteTransactionHook })[SQLITE_TRANSACTION];
  if (typeof hook !== "function") return Promise.reject(new Error(NO_HOOK));
  return hook(cb);
}

const NO_READ_ONLY_HOOK =
  "inReadOnlyTransaction: this Db has no SQLite read-only transaction hook. It is not a " +
  "@statewalker/db-sqlite* Db (or one from a db-sqlite older than 0.1.4), " +
  "or it wraps one (a wrapper object loses the hook - pass the driver's Db itself), " +
  "or it is the handle of a running transaction (nesting is not supported).";

/**
 * Run `cb` in one SQLite transaction that is always rolled back: `tx` sees the committed data and
 * its own writes, and nothing it writes persists, whether `cb` returns (its value is returned) or
 * throws (its error is rethrown). Statements that would end the transaction or reach outside it
 * (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE, ATTACH, DETACH, PRAGMA, VACUUM) are refused,
 * and once a statement fails, `tx` refuses every later call (SQLite may have ended the transaction
 * itself, as `INSERT OR ROLLBACK` does). Other calls on `db` wait until it ends. `cb` must not do
 * external I/O and must be idempotent: a Durable Object may run it more than once.
 */
export function inReadOnlyTransaction<T>(db: Db, cb: (tx: Db) => Promise<T>): Promise<T> {
  const hook = (db as { [SQLITE_READ_ONLY_TRANSACTION]?: SqliteTransactionHook })[
    SQLITE_READ_ONLY_TRANSACTION
  ];
  if (typeof hook !== "function") return Promise.reject(new Error(NO_READ_ONLY_HOOK));
  return hook(cb);
}

/** Whether `db` carries the hook {@link inReadOnlyTransaction} needs. */
export function hasReadOnlyTransaction(db: Db): boolean {
  return (
    typeof (db as { [SQLITE_READ_ONLY_TRANSACTION]?: unknown })[SQLITE_READ_ONLY_TRANSACTION] ===
    "function"
  );
}
