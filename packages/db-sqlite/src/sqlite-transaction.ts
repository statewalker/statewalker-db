import type { Db } from "@statewalker/db-api";

/** Key under which a SQLite Db carries its transaction hook. Shared across bundles via Symbol.for. */
export const SQLITE_TRANSACTION: unique symbol = Symbol.for("@statewalker/db-sqlite:transaction");

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
