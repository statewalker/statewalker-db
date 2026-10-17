import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DoSqlStorage } from "./do-sqlite-db.js";

export type FakeDoStorage = DoSqlStorage & { close(): void };

/** Limits probed on celld's DO SQLite (see test-do/platform-probe.ts). */
const MAX_BOUND_PARAMETERS = 100;
const MAX_BLOB_BYTES = 2_000_000;
const NOT_AUTHORIZED = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/i;

/**
 * An in-memory stand-in for a Durable Object's `ctx.storage` on Node.js's `node:sqlite`, with the
 * DO limits: no SQL-level transactions or PRAGMA, at most 100 bound parameters, BLOBs bound and
 * read as ArrayBuffer and at most ~2 MB. `transaction` runs the closure between BEGIN and
 * COMMIT/ROLLBACK and, like the platform, does not queue concurrent calls.
 */
export function newFakeDoStorage(): FakeDoStorage {
  const db = new DatabaseSync(":memory:");
  const bind = (value: unknown): SQLInputValue => {
    if (ArrayBuffer.isView(value)) {
      throw new TypeError("fake DO storage: bind a BLOB as an ArrayBuffer, not a typed array");
    }
    if (value instanceof ArrayBuffer) {
      if (value.byteLength > MAX_BLOB_BYTES) {
        throw new Error("SQL error: bind sync KV cursor: string or blob too big");
      }
      return new Uint8Array(value);
    }
    return value as SQLInputValue;
  };
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        if (NOT_AUTHORIZED.test(query))
          throw new Error("SQL error: prepare SQL cursor: not authorized");
        if (bindings.length > MAX_BOUND_PARAMETERS) {
          throw new Error("SQL error: prepare SQL cursor: too many SQL variables");
        }
        const statement = db.prepare(query);
        let rows: Record<string, unknown>[] = [];
        // prepare() compiles only the first statement: run row-less, parameter-less text with exec().
        if (bindings.length === 0 && statement.columns().length === 0) db.exec(query);
        else rows = statement.all(...bindings.map(bind)) as Record<string, unknown>[];
        const out = rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array ? value.slice().buffer : value,
            ]),
          ),
        );
        return { toArray: () => out };
      },
    },
    async transaction<T>(closure: () => Promise<T>): Promise<T> {
      db.exec("BEGIN");
      try {
        const result = await closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        // ON CONFLICT ROLLBACK has already ended the transaction; a second ROLLBACK would mask `error`.
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
