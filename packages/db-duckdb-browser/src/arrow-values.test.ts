import type { DuckDBConnection } from "@duckdb/duckdb-wasm/blocking";
import { beforeAll, describe, expect, it } from "vitest";
import { arrowTableToObjects } from "./arrow-values.js";
import { openWasmNodeConnection } from "./test-wasm-node.js";

/**
 * Real Arrow results from duckdb-wasm (its Node blocking bindings), converted
 * by the driver's row conversion. Expected values are what
 * `@statewalker/db-duckdb-node` returns (`getRowObjectsJS`) for the same SQL.
 */
describe("arrowTableToObjects", () => {
  let conn: DuckDBConnection;

  beforeAll(async () => {
    conn = await openWasmNodeConnection();
  });

  function row(sql: string): Record<string, unknown> {
    const rows = arrowTableToObjects<Record<string, unknown>>(conn.query(sql));
    expect(rows).toHaveLength(1);
    return rows[0] as Record<string, unknown>;
  }

  it("returns DECIMAL as a scaled number", () => {
    const r = row(
      "SELECT 1.25::DECIMAL(10,2) AS a, -0.05::DECIMAL(4,2) AS b, 1.5::DECIMAL(18,3) AS c, 1.25::DECIMAL(38,10) AS d, NULL::DECIMAL(10,2) AS n",
    );
    expect(r).toEqual({ a: 1.25, b: -0.05, c: 1.5, d: 1.25, n: null });
    expect(typeof r.a).toBe("number");
  });

  it("returns HUGEINT as bigint, like the node driver", () => {
    const r = row("SELECT -170141183460469231731687303715884105727::HUGEINT AS h, 5::HUGEINT AS s");
    expect(r.h).toBe(-170141183460469231731687303715884105727n);
    expect(r.s).toBe(5n);
  });

  it("returns DATE and TIMESTAMP as Date", () => {
    const r = row(
      "SELECT DATE '2024-01-02' AS d, TIMESTAMP '2024-01-02 03:04:05.123' AS ts, TIMESTAMPTZ '2024-01-02 03:04:05+00' AS tz",
    );
    expect(r.d).toEqual(new Date("2024-01-02T00:00:00.000Z"));
    expect(r.ts).toEqual(new Date("2024-01-02T03:04:05.123Z"));
    expect(r.tz).toEqual(new Date("2024-01-02T03:04:05.000Z"));
  });

  it("returns LIST and fixed-size ARRAY as plain arrays, recursively", () => {
    const r = row(
      "SELECT [1,2] AS l, [1,2]::INTEGER[2] AS a, [[1],[2,3]] AS ll, [DATE '2024-01-02'] AS ld, []::INTEGER[] AS e",
    );
    expect(r.l).toEqual([1, 2]);
    expect(Array.isArray(r.l)).toBe(true);
    expect(r.a).toEqual([1, 2]);
    expect(Array.isArray(r.a)).toBe(true);
    expect(r.ll).toEqual([[1], [2, 3]]);
    expect(Array.isArray((r.ll as unknown[])[0])).toBe(true);
    expect(r.ld).toEqual([new Date("2024-01-02T00:00:00.000Z")]);
    expect(r.e).toEqual([]);
  });

  it("returns STRUCT as a plain object, recursively", () => {
    const r = row(
      "SELECT {'a': 1, 'b': [{'c': 'x'}], 'd': DATE '2024-01-02', 'm': 1.25::DECIMAL(10,2)} AS s",
    );
    expect(r.s).toEqual({
      a: 1,
      b: [{ c: "x" }],
      d: new Date("2024-01-02T00:00:00.000Z"),
      m: 1.25,
    });
    expect(Object.getPrototypeOf(r.s)).toBe(Object.prototype);
  });

  it("returns MAP as an array of {key, value}, like the node driver", () => {
    const r = row("SELECT MAP {'k': 1, 'j': 2} AS m");
    expect(r.m).toEqual([
      { key: "k", value: 1 },
      { key: "j", value: 2 },
    ]);
  });

  it("keeps BIGINT as bigint and plain scalars as they are", () => {
    const r = row(
      "SELECT 5::BIGINT AS b, 5::INTEGER AS i, 1.5::DOUBLE AS f, 'x' AS s, true AS t, 'ab'::BLOB AS bl, 'b'::ENUM('a','b') AS e, NULL AS n",
    );
    expect(r.b).toBe(5n);
    expect(r.i).toBe(5);
    expect(r.f).toBe(1.5);
    expect(r.s).toBe("x");
    expect(r.t).toBe(true);
    expect(r.bl).toEqual(new Uint8Array([97, 98]));
    expect(r.e).toBe("b");
    expect(r.n).toBeNull();
  });

  it("converts the issue's example row", () => {
    const r = row(
      "SELECT 1.25::DECIMAL(10,2) AS d, DATE '2024-01-02' AS dt, [1,2] AS l, {'a':1} AS s",
    );
    expect(r).toEqual({
      d: 1.25,
      dt: new Date("2024-01-02T00:00:00.000Z"),
      l: [1, 2],
      s: { a: 1 },
    });
  });
});
