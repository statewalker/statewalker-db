import type { Db } from "@statewalker/db-api";
import { newSerialisedSqliteDb } from "@statewalker/db-sqlite";

/** The rows of one `ctx.storage.sql.exec` call. */
export interface DoSqlCursor {
  toArray(): Record<string, unknown>[];
}

/** The part of a Durable Object's `ctx.storage` this driver uses; `ctx.storage` fits it as is. */
export interface DoSqlStorage {
  sql: { exec(query: string, ...bindings: unknown[]): DoSqlCursor };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

/** DO SQLite binds BLOBs from ArrayBuffer; copy exactly the view's bytes. */
const toDoValue = (value: unknown): unknown =>
  ArrayBuffer.isView(value)
    ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    : value;

/** DO SQLite reads BLOBs back as ArrayBuffer; every SQLite Db returns Uint8Array. */
const fromDoRow = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    ]),
  );

/**
 * A {@link Db} over a Durable Object's SQLite storage (`ctx.storage`). Transactions go through
 * `storage.transaction`, since DO SQLite rejects `BEGIN`. Create one per DO, in its constructor.
 */
export function newDoSqliteDb(storage: DoSqlStorage): Db {
  return newSerialisedSqliteDb({
    all: (sql, params) =>
      storage.sql
        .exec(sql, ...params.map(toDoValue))
        .toArray()
        .map(fromDoRow),
    exec: (sql) => {
      storage.sql.exec(sql).toArray();
    },
    close: () => {},
    transaction: (fn) => storage.transaction(fn),
  });
}
