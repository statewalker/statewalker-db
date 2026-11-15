/**
 * Conversion of Arrow values (as duckdb-wasm returns them) into the plain JS
 * values `@statewalker/db-duckdb-node` returns for the same SQL types.
 *
 * Typed structurally so this module does not import `apache-arrow` at runtime.
 * Type ids are Arrow's `Type` enum (apache-arrow 17, the version duckdb-wasm
 * depends on).
 */

const TypeId = {
  Dictionary: -1,
  Decimal: 7,
  Date: 8,
  Timestamp: 10,
  List: 12,
  Struct: 13,
  FixedSizeList: 16,
  Map: 17,
} as const;

/** Arrow `TimeUnit`. */
const TimeUnit = { SECOND: 0, MILLISECOND: 1, MICROSECOND: 2, NANOSECOND: 3 } as const;

/** The parts of an Arrow `Field` this module reads. */
export interface ArrowFieldLike {
  name: string;
  type: ArrowTypeLike;
}

/** The parts of an Arrow `DataType` this module reads. */
export interface ArrowTypeLike {
  typeId: number;
  scale?: number;
  precision?: number;
  unit?: number;
  children?: ArrowFieldLike[] | null;
  dictionary?: ArrowTypeLike;
}

/** The parts of an Arrow `Table` this module reads. */
export interface ArrowTableLike {
  schema: { fields: ArrowFieldLike[] };
  toArray(): ArrayLike<unknown>;
}

/**
 * Convert an Arrow table into plain row objects, converting each value by its
 * field's Arrow type ({@link arrowValueToJs}).
 */
export function arrowTableToObjects<T>(table: ArrowTableLike): T[] {
  const fields = table.schema.fields;
  return Array.from(table.toArray(), (row) => {
    const source = row as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const field of fields) {
      obj[field.name] = arrowValueToJs(source[field.name], field.type);
    }
    return obj as T;
  });
}

/**
 * Convert one Arrow value into the plain JS value the node driver returns:
 *
 * - DECIMAL: a `number` scaled by the type's scale (HUGEINT, which DuckDB sends
 *   as DECIMAL(38,0), becomes a `bigint`);
 * - DATE, TIMESTAMP: a `Date`;
 * - LIST, fixed-size ARRAY: an array, converted recursively;
 * - STRUCT: a plain object, converted recursively;
 * - MAP: an array of `{ key, value }`, converted recursively.
 *
 * Other values (numbers, `bigint` for BIGINT, strings, booleans, `Uint8Array`
 * for BLOB, `null`) are returned as they are.
 */
export function arrowValueToJs(value: unknown, type: ArrowTypeLike): unknown {
  if (value === null || value === undefined) return null;
  switch (type.typeId) {
    case TypeId.Decimal:
      return decimalToJs(value, type);
    case TypeId.Date:
      return typeof value === "number" ? new Date(value) : value;
    case TypeId.Timestamp:
      return timestampToDate(value, type.unit);
    case TypeId.List:
    case TypeId.FixedSizeList: {
      const childType = type.children?.[0]?.type;
      const items = Array.from(value as Iterable<unknown>);
      return childType ? items.map((item) => arrowValueToJs(item, childType)) : items;
    }
    case TypeId.Struct: {
      const row = value as Record<string, unknown>;
      const obj: Record<string, unknown> = {};
      for (const child of type.children ?? []) {
        obj[child.name] = arrowValueToJs(row[child.name], child.type);
      }
      return obj;
    }
    case TypeId.Map: {
      const entryFields = type.children?.[0]?.type.children ?? [];
      const keyType = entryFields[0]?.type;
      const valueType = entryFields[1]?.type;
      return Array.from(value as Iterable<[unknown, unknown]>, ([key, val]) => ({
        key: keyType ? arrowValueToJs(key, keyType) : key,
        value: valueType ? arrowValueToJs(val, valueType) : val,
      }));
    }
    case TypeId.Dictionary:
      return type.dictionary ? arrowValueToJs(value, type.dictionary) : value;
    default:
      return value;
  }
}

/**
 * Arrow decimals are unscaled integers (`String(v)` gives the digits). Insert
 * the decimal point by text and parse, so the result is the nearest double to
 * the exact decimal value.
 */
function decimalToJs(value: unknown, type: ArrowTypeLike): number | bigint {
  const digits = String(value);
  const scale = type.scale ?? 0;
  if (scale === 0) {
    // DuckDB sends HUGEINT as DECIMAL(38,0); the node driver returns bigint.
    return type.precision === 38 ? BigInt(digits) : Number(digits);
  }
  const negative = digits.startsWith("-");
  const abs = (negative ? digits.slice(1) : digits).padStart(scale + 1, "0");
  const text = `${abs.slice(0, abs.length - scale)}.${abs.slice(abs.length - scale)}`;
  return Number(negative ? `-${text}` : text);
}

function timestampToDate(value: unknown, unit: number | undefined): unknown {
  if (typeof value === "number") return new Date(value); // apache-arrow gives epoch ms
  if (typeof value === "bigint") {
    switch (unit) {
      case TimeUnit.SECOND:
        return new Date(Number(value) * 1000);
      case TimeUnit.MICROSECOND:
        return new Date(Number(value / 1000n));
      case TimeUnit.NANOSECOND:
        return new Date(Number(value / 1000000n));
      default:
        return new Date(Number(value));
    }
  }
  return value;
}
