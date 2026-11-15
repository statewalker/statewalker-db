/** A value duckdb-wasm's prepared statements can bind (they JSON-encode params). */
export type DuckDbWasmParam = string | number | boolean | null;

/**
 * Convert `Db.query` params into values duckdb-wasm can bind.
 *
 * duckdb-wasm passes prepared-statement params through `JSON.stringify`, so
 * only strings, finite numbers, booleans and `null` survive. This maps:
 *
 * - `bigint` to its exact decimal string; DuckDB casts it to the column type
 *   where the context fixes one (`WHERE id = $1`, `INSERT ... VALUES ($1)`),
 *   elsewhere cast it in SQL (`$1::BIGINT`);
 * - `Date` to its ISO 8601 string, which DuckDB casts to TIMESTAMP the same way;
 * - `undefined` to `null`.
 *
 * Anything else (`Uint8Array` and other binary data, arrays, plain objects,
 * `NaN`, `Infinity`, symbols, functions, invalid dates) throws a `TypeError`
 * naming the parameter and its type instead of failing inside duckdb-wasm or
 * binding the wrong value.
 */
export function toDuckDbParams(params: readonly unknown[]): DuckDbWasmParam[] {
  return params.map(toDuckDbParam);
}

function toDuckDbParam(value: unknown, index: number): DuckDbWasmParam {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "undefined":
      return null;
    case "bigint":
      return value.toString();
    case "number":
      if (Number.isFinite(value)) return value;
      throw unsupported(index, String(value));
    case "object": {
      if (value === null) return null;
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw unsupported(index, "invalid Date");
        return value.toISOString();
      }
      if (Array.isArray(value)) throw unsupported(index, "array");
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        throw unsupported(index, value.constructor.name);
      }
      throw unsupported(index, `object (${value.constructor?.name ?? "null prototype"})`);
    }
    default:
      throw unsupported(index, typeof value);
  }
}

function unsupported(index: number, type: string): TypeError {
  return new TypeError(
    `db-duckdb-browser: cannot bind parameter $${index + 1} of type ${type}; ` +
      "duckdb-wasm binds only string, finite number, boolean, null, bigint and Date",
  );
}
