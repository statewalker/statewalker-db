import type { Db, DbEntry } from "@statewalker/db-api";

/**
 * The calls of one `Db`, run one at a time in call order. Once `close()` has started, `run`
 * rejects at once with `<name>: the database is closed`; `close()` itself queues behind every
 * earlier call, closes the engine once, and returns the same promise to every later caller.
 */
export type DbCallQueue = {
  run<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export function newDbCallQueue(name: string, closeEngine: () => void | Promise<void>): DbCallQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const enqueue = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    run: (fn) =>
      closing ? Promise.reject(new Error(`${name}: the database is closed`)) : enqueue(fn),
    close: () => {
      closing ??= enqueue(closeEngine);
      return closing;
    },
  };
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A bigint within ±(2^53 - 1) as a number; arrays and plain objects converted in place. */
function safeInteger(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = safeInteger(value[i]);
  } else if (value !== null && typeof value === "object" && isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    for (const key in record) record[key] = safeInteger(record[key]);
  }
  return value;
}

/**
 * Integers within ±(2^53 - 1) become numbers, larger ones stay bigints (no precision loss), in
 * every column and inside list, struct and map values. The rows are converted in place.
 */
export function toSafeIntegers<T extends Record<string, unknown>>(rows: T[]): T[] {
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    for (const key in record) record[key] = safeInteger(record[key]);
  }
  return rows;
}

/**
 * The asynchronous engine a driver wraps with {@link newSerialisedDb}. It is called one call at a
 * time and never after `close`; `query` returns rows with integers as numbers or bigints (the
 * wrapper turns safe bigints into numbers).
 */
export type SerialisedDbEngine = {
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<void>;
  flush?(): Promise<void>;
  close(): void | Promise<void>;
};

/**
 * Wrap an engine as a `Db` that keeps the lifecycle every driver shares: calls run one at a time,
 * in call order; `close()` waits for the calls made before it, then closes the engine; calls made
 * once `close()` has started reject with `<name>: the database is closed`; closing twice is a
 * no-op. Integers come back as numbers when safe and as bigints beyond (see
 * {@link toSafeIntegers}). `name` prefixes the error, e.g. `"db-pglite"`.
 */
export function newSerialisedDb(engine: SerialisedDbEngine, options: { name: string }): Db {
  const queue = newDbCallQueue(options.name, () => engine.close());
  const db: Db = {
    query: <T = DbEntry>(sql: string, params: unknown[] = []) =>
      queue.run(async () => toSafeIntegers(await engine.query(sql, params)) as T[]),
    exec: (sql: string) => queue.run(() => engine.exec(sql)),
    close: () => queue.close(),
  };
  const flush = engine.flush?.bind(engine);
  if (flush) db.flush = () => queue.run(flush);
  return db;
}
