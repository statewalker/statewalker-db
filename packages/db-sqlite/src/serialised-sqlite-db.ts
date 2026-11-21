import type { Db, DbEntry } from "@statewalker/db-api";
import { newDbCallQueue, toSafeIntegers } from "./serialised-db.js";
import { countSqlStatements, firstSqlStatement, sqlStatementHeads } from "./sql-statements.js";
import {
  SQLITE_READ_ONLY_TRANSACTION,
  SQLITE_TRANSACTION,
  type SqliteTransactionHook,
} from "./sqlite-transaction.js";

/**
 * The synchronous engine a SQLite driver wraps. `all` returns rows (BLOBs as Uint8Array; integers
 * as numbers or bigints, which the wrapper turns into numbers when they are safe) and is given
 * exactly one non-empty statement and parameters already normalised and checked (only null,
 * number, bigint, string and Uint8Array); `exec` runs every statement of a non-empty string.
 * `transaction`, when present, replaces `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` (Durable Objects
 * forbid them in SQL).
 */
export type SqliteEngine = {
  all(sql: string, params: unknown[]): Record<string, unknown>[];
  exec(sql: string): void;
  close(): void;
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
};

const EMPTY_SQL = "db-sqlite: the SQL is empty (only whitespace, comments or semicolons)";
const MANY_STATEMENTS =
  "db-sqlite: query runs one statement, and this SQL has more after the first; " +
  "run them one query at a time, or use exec (no parameters, no rows)";

function checkSql(sql: string, one: boolean): void {
  if (typeof sql !== "string") throw new TypeError("db-sqlite: the SQL must be a string");
  const count = countSqlStatements(sql);
  if (count === "empty") throw new Error(EMPTY_SQL);
  if (one && count === "many") throw new Error(MANY_STATEMENTS);
}

/** The type a rejected parameter is named by: `symbol`, `function`, or the object's class. */
function typeName(value: unknown): string {
  if (typeof value !== "object" || value === null) return typeof value;
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name ? name : "Object";
}

/**
 * boolean → 1/0, undefined → NULL, Date → ISO 8601 UTC text, ArrayBuffer or any ArrayBuffer view →
 * a Uint8Array over exactly its bytes; null, number, bigint and string are left as given. Anything
 * else (a plain object, Map, array, function, symbol, boxed primitive) rejects: node:sqlite would
 * take a leading object as named parameters and bind the rest one place to the left, and SQLite
 * has no array type (bind a list as JSON text and read it with `json_each`).
 */
function toSqliteParam(value: unknown, index: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError(`db-sqlite: parameter ${index + 1} is an invalid Date`);
    }
    return value.toISOString();
  }
  // node:sqlite (Node 22) binds a view over a buffer with no backing store (any zero-length
  // ArrayBuffer) as NULL: give an empty value a fresh empty Uint8Array, which binds as a BLOB.
  if ((ArrayBuffer.isView(value) || value instanceof ArrayBuffer) && value.byteLength === 0) {
    return new Uint8Array(1).subarray(0, 0);
  }
  if (value instanceof Uint8Array && value.constructor === Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const hint = Array.isArray(value) ? "; bind a list as JSON text and read it with json_each" : "";
  throw new TypeError(
    `db-sqlite: parameter ${index + 1} has type ${typeName(value)}, which SQLite cannot bind; ` +
      "pass null, undefined, a boolean, number, bigint, string, Date, ArrayBuffer or " +
      `ArrayBuffer view${hint}`,
  );
}

function runAll(engine: SqliteEngine, sql: string, params: unknown[]): Record<string, unknown>[] {
  checkSql(sql, true);
  // Only the statement itself reaches the engine: DO SQLite rejects an empty tail ("; -- c ;").
  return toSafeIntegers(engine.all(firstSqlStatement(sql), params.map(toSqliteParam)));
}

function runExec(engine: SqliteEngine, sql: string): void {
  checkSql(sql, false);
  engine.exec(sql);
}

/** Statements a read-only transaction refuses: they end it, or reach outside it. */
const READ_ONLY_REFUSED = new Set([
  "begin",
  "commit",
  "end",
  "rollback",
  "savepoint",
  "release",
  "attach",
  "detach",
  "pragma",
  "vacuum",
]);

function checkReadOnly(sql: string): void {
  if (typeof sql !== "string") return; // checkSql reports it
  for (const head of sqlStatementHeads(sql)) {
    if (READ_ONLY_REFUSED.has(head)) {
      throw new Error(
        `db-sqlite: a read-only transaction refuses ${head.toUpperCase()} ` +
          "(it would end the transaction or reach outside it)",
      );
    }
  }
}

const READ_ONLY_FAILED =
  "db-sqlite: a statement of this read-only transaction failed, so it refuses later calls " +
  "(SQLite may have ended the transaction)";
const ROLLBACK_ON_PURPOSE = "db-sqlite: the read-only transaction is rolled back";

/**
 * Wrap an engine as a `Db` with the lifecycle of `newSerialisedDb` (calls run one at a time, in
 * call order; `close()` waits for earlier calls; later calls reject with
 * `db-sqlite: the database is closed`; closing twice is a no-op) and the `inTransaction` hook.
 * Every SQLite driver gets the same input handling here: empty SQL rejects, `query` rejects a
 * second statement, parameters are normalised (one SQLite cannot bind rejects) and safe integers come back as numbers. The `tx`
 * handed to a transaction callback bypasses the queue, has no hook (so nesting is rejected) and
 * rejects once its transaction has finished.
 */
export function newSerialisedSqliteDb(engine: SqliteEngine): Db {
  const queue = newDbCallQueue("db-sqlite", () => engine.close());
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

  const platformTransaction = engine.transaction?.bind(engine);
  const runReadOnlyTransaction = platformTransaction
    ? async <T>(fn: () => Promise<T>): Promise<T> => {
        // The platform commits when the closure returns: throw to make it roll back.
        let result: T | undefined;
        let returned = false;
        try {
          await platformTransaction(async () => {
            returned = false;
            result = await fn();
            returned = true;
            throw new Error(ROLLBACK_ON_PURPOSE);
          });
        } catch (error) {
          if (returned && error instanceof Error && error.message === ROLLBACK_ON_PURPOSE) {
            return result as T;
          }
          throw error;
        }
        throw new Error("db-sqlite: the platform did not roll back the read-only transaction");
      }
    : async <T>(fn: () => Promise<T>): Promise<T> => {
        // A ROLLBACK that fails for any reason but "no transaction" (SQLite ended it itself, as
        // INSERT OR ROLLBACK does: nothing to undo) leaves the transaction open: report it.
        const rollback = () => {
          try {
            engine.exec("ROLLBACK");
          } catch (error) {
            if (!/no transaction is active/i.test(String((error as Error)?.message))) throw error;
          }
        };
        engine.exec("BEGIN");
        let result: T;
        try {
          result = await fn();
        } catch (error) {
          rollback();
          throw error;
        }
        rollback();
        return result;
      };

  const newTransactionHook =
    (readOnly: boolean): SqliteTransactionHook =>
    (cb) =>
      queue.run(async () => {
        let finished = false;
        let failed = false;
        const run = <R>(fn: () => R): R => {
          if (finished) throw new Error("db-sqlite: the transaction is finished; use the outer Db");
          if (!readOnly) return fn();
          if (failed) throw new Error(READ_ONLY_FAILED);
          try {
            return fn();
          } catch (error) {
            failed = true;
            throw error;
          }
        };
        const tx: Db = {
          async query<T = DbEntry>(sql: string, params: unknown[] = []): Promise<T[]> {
            return run(() => {
              if (readOnly) checkReadOnly(sql);
              return runAll(engine, sql, params) as T[];
            });
          },
          async exec(sql: string): Promise<void> {
            run(() => {
              if (readOnly) checkReadOnly(sql);
              runExec(engine, sql);
            });
          },
          async close(): Promise<void> {
            throw new Error("db-sqlite: close the outer Db, not the transaction handle");
          },
        };
        try {
          return await (readOnly ? runReadOnlyTransaction : runTransaction)(() => cb(tx));
        } finally {
          finished = true;
        }
      });

  return {
    query: <T = DbEntry>(sql: string, params: unknown[] = []) =>
      queue.run(() => runAll(engine, sql, params) as T[]),
    exec: (sql: string) => queue.run(() => runExec(engine, sql)),
    close: () => queue.close(),
    [SQLITE_TRANSACTION]: newTransactionHook(false),
    [SQLITE_READ_ONLY_TRANSACTION]: newTransactionHook(true),
  } as Db;
}
