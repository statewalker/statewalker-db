import type {
  DuckDBConnection,
  DuckDBPreparedStatement,
  DuckDBType,
  DuckDBValue,
} from "@duckdb/node-api";
import {
  BIGINT,
  BLOB,
  BOOLEAN,
  blobValue,
  DOUBLE,
  DuckDBInstance,
  DuckDBTypeId,
  HUGEINT,
  INTEGER,
  LIST,
  listValue,
  TIMESTAMP,
  TIMESTAMPTZ,
  timestampTZValue,
  timestampValue,
  VARCHAR,
} from "@duckdb/node-api";
import type { Db, DbEntry, DbOptions } from "@statewalker/db-api";

/**
 * Create a DuckDB-backed {@link Db} using native Node.js bindings.
 *
 * @param options.path  File path for persistent storage. Omit for in-memory.
 */
export async function newNodeDuckDb(options?: DbOptions): Promise<Db> {
  const instance = await DuckDBInstance.create(options?.path ?? ":memory:");
  const connection = await instance.connect();

  return {
    async query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]> {
      await assertSingleStatement(connection, sql);
      if (params && params.length > 0) {
        const prepared = await connection.prepare(sql);
        try {
          bindParams(prepared, params);
          const reader = await prepared.runAndReadAll();
          return reader.getRowObjectsJS() as T[];
        } finally {
          prepared.destroySync();
        }
      }
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJS() as T[];
    },

    async exec(sql: string): Promise<void> {
      await connection.run(sql);
    },

    async close(): Promise<void> {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

/**
 * `query` returns one result set, so it refuses SQL holding several
 * statements (DuckDB would otherwise silently return the first one's rows).
 * When extraction itself fails (empty SQL, a syntax error), the statement
 * runs as usual and DuckDB reports its own result or error.
 */
async function assertSingleStatement(connection: DuckDBConnection, sql: string): Promise<void> {
  let count: number;
  try {
    count = (await connection.extractStatements(sql)).count;
  } catch {
    return;
  }
  if (count > 1) {
    throw new Error(
      `query() runs one statement, but the SQL holds ${count}; use exec() for several statements.`,
    );
  }
}

function bindParams(prepared: DuckDBPreparedStatement, params: unknown[]): void {
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    const index = i + 1;
    if (isListLike(param)) {
      // Dates bound into TIMESTAMPTZ[] must be instants too, not TIMESTAMPs cast in the session
      // time zone: bind with the statement's type and TIMESTAMPTZ items.
      const tzType = onlyDates(param) ? timestampTzListType(prepared, index) : undefined;
      if (tzType) {
        prepared.bindValue(index, toDuckDBValue(param, true), tzType);
        continue;
      }
      // DuckDB infers a list's type from its first item, so `[0, 0.5]` would
      // become INTEGER[] and fail; infer it from all items instead. An empty
      // list has no items: take its type from the statement when it is known.
      const type = listType(param) ?? listParameterType(prepared, index);
      if (type) {
        prepared.bindValue(index, toDuckDBValue(param), type);
        continue;
      }
    }
    if (param instanceof Date && parameterTypeId(prepared, index) === DuckDBTypeId.TIMESTAMP_TZ) {
      // A TIMESTAMP is cast to TIMESTAMPTZ in the session time zone, which would shift the
      // instant by the local offset: bind the instant itself.
      prepared.bindValue(index, timestampTZValue(dateMicros(param)), TIMESTAMPTZ);
      continue;
    }
    prepared.bindValue(index, toDuckDBValue(param));
  }
}

/** Whether a (nested) list holds at least one Date and nothing else but nulls. */
function onlyDates(list: ListLike): boolean {
  let dates = 0;
  const visit = (items: ListLike): boolean => {
    for (const item of Array.from(items)) {
      if (item === null || item === undefined) continue;
      if (item instanceof Date) dates++;
      else if (!isListLike(item) || !visit(item)) return false;
    }
    return true;
  };
  return visit(list) && dates > 0;
}

/**
 * The statement's type for parameter `index` when it is a (nested) list or array of TIMESTAMPTZ,
 * as nested LISTs (DuckDB casts a list into a fixed-size array); otherwise `undefined`.
 */
function timestampTzListType(
  prepared: DuckDBPreparedStatement,
  index: number,
): DuckDBType | undefined {
  let type: DuckDBType;
  try {
    type = prepared.parameterType(index);
  } catch {
    return undefined;
  }
  const rebuild = (t: DuckDBType): DuckDBType | undefined => {
    if (t.typeId === DuckDBTypeId.LIST || t.typeId === DuckDBTypeId.ARRAY) {
      const item = rebuild(t.valueType);
      return item ? LIST(item) : undefined;
    }
    return t.typeId === DuckDBTypeId.TIMESTAMP_TZ ? TIMESTAMPTZ : undefined;
  };
  return type.typeId === DuckDBTypeId.LIST || type.typeId === DuckDBTypeId.ARRAY
    ? rebuild(type)
    : undefined;
}

function parameterTypeId(prepared: DuckDBPreparedStatement, index: number) {
  try {
    return prepared.parameterType(index).typeId;
  } catch {
    return undefined;
  }
}

/** Microseconds since the epoch; an invalid `Date` throws. */
function dateMicros(value: Date): bigint {
  const millis = value.getTime();
  if (Number.isNaN(millis)) {
    throw new TypeError("Invalid Date passed as a query parameter.");
  }
  return BigInt(millis) * 1000n;
}

function listParameterType(prepared: DuckDBPreparedStatement, index: number) {
  try {
    const type = prepared.parameterType(index);
    return type.typeId === DuckDBTypeId.LIST ? type : undefined;
  } catch {
    return undefined;
  }
}

/** The LIST type of a JS list, or `undefined` when its items do not tell. */
function listType(list: ListLike): DuckDBType | undefined {
  const itemType = commonType(Array.from(list));
  return itemType ? LIST(itemType) : undefined;
}

function commonType(items: unknown[]): DuckDBType | undefined {
  const present = items.filter((item) => item !== null && item !== undefined);
  if (present.length === 0) return undefined;
  if (present.every((item) => typeof item === "number")) {
    if (!present.every(Number.isInteger)) return DOUBLE;
    return present.every((n) => n >= -2_147_483_648 && n <= 2_147_483_647) ? INTEGER : BIGINT;
  }
  if (present.every(isListLike)) {
    const itemType = commonType(present.flatMap((list) => Array.from(list)));
    return itemType ? LIST(itemType) : undefined;
  }
  if (present.every((item) => typeof item === "string")) return VARCHAR;
  if (present.every((item) => typeof item === "boolean")) return BOOLEAN;
  if (present.every((item) => typeof item === "bigint")) return HUGEINT;
  if (present.every((item) => item instanceof Uint8Array)) return BLOB;
  if (present.every((item) => item instanceof Date)) return TIMESTAMP;
  return undefined;
}

type ListLike = ArrayLike<unknown> & Iterable<unknown>;

function isListLike(value: unknown): value is ListLike {
  return (
    Array.isArray(value) ||
    (ArrayBuffer.isView(value) && !(value instanceof DataView) && !(value instanceof Uint8Array))
  );
}

/**
 * Map JS values DuckDB cannot type on its own: `Uint8Array` to BLOB, `Date`
 * to TIMESTAMP (microseconds since the epoch, UTC; `bindParams` binds TIMESTAMPTZ
 * where the statement expects one), arrays and non-byte typed
 * arrays to LIST (recursively). Everything else is bound as is.
 */
function toDuckDBValue(value: unknown, timestampTz = false): DuckDBValue {
  if (value instanceof Uint8Array) {
    return blobValue(value);
  }
  if (value instanceof Date) {
    const micros = dateMicros(value);
    return timestampTz ? timestampTZValue(micros) : timestampValue(micros);
  }
  if (isListLike(value)) {
    return listValue(Array.from(value, (item) => toDuckDBValue(item, timestampTz)));
  }
  return value as DuckDBValue;
}
