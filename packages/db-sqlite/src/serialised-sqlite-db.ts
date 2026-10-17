import type { Db, DbEntry } from "@statewalker/db-api";
import { SQLITE_TRANSACTION, type SqliteTransactionHook } from "./sqlite-transaction.js";

/**
 * The synchronous engine a SQLite driver wraps. `all` returns rows (BLOBs as Uint8Array) and must
 * run exactly one statement; `exec` runs every statement of a string. `transaction`, when present,
 * replaces `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` (Durable Objects forbid them in SQL).
 */
export type SqliteEngine = {
  all(sql: string, params: unknown[]): Record<string, unknown>[];
  exec(sql: string): void;
  close(): void;
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
};

function newLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Wrap an engine as a `Db` whose calls run one at a time, in call order, and which carries the
 * `inTransaction` hook. The `tx` handed to a transaction callback bypasses the queue, has no hook
 * (so nesting is rejected) and rejects once its transaction has finished.
 */
export function newSerialisedSqliteDb(engine: SqliteEngine): Db {
  const lock = newLock();
  let closed = false;
  const live = () => {
    if (closed) throw new Error("db-sqlite: the database is closed");
  };
  const runTransaction =
    engine.transaction?.bind(engine) ??
    (async <T>(fn: () => Promise<T>): Promise<T> => {
      engine.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        engine.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          engine.exec("ROLLBACK");
        } catch {
          // SQLite already ended the transaction itself (ON CONFLICT ROLLBACK, auto-rollback)
        }
        throw error;
      }
    });

  const transaction: SqliteTransactionHook = (cb) =>
    lock(async () => {
      live();
      let finished = false;
      const open = () => {
        if (finished) throw new Error("db-sqlite: the transaction is finished; use the outer Db");
      };
      const tx: Db = {
        async query<T = DbEntry>(sql: string, params: unknown[] = []): Promise<T[]> {
          open();
          return engine.all(sql, params) as T[];
        },
        async exec(sql: string): Promise<void> {
          open();
          engine.exec(sql);
        },
        async close(): Promise<void> {
          throw new Error("db-sqlite: close the outer Db, not the transaction handle");
        },
      };
      try {
        return await runTransaction(() => cb(tx));
      } finally {
        finished = true;
      }
    });

  return {
    query: <T = DbEntry>(sql: string, params: unknown[] = []) =>
      lock(async () => {
        live();
        return engine.all(sql, params) as T[];
      }),
    exec: (sql: string) =>
      lock(async () => {
        live();
        engine.exec(sql);
      }),
    close: () =>
      lock(async () => {
        if (closed) return;
        closed = true;
        engine.close();
      }),
    [SQLITE_TRANSACTION]: transaction,
  } as Db;
}
