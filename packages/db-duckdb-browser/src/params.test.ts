import type { DuckDBConnection } from "@duckdb/duckdb-wasm/blocking";
import { beforeAll, describe, expect, it } from "vitest";
import { arrowTableToObjects } from "./arrow-values.js";
import { toDuckDbParams } from "./params.js";
import { openWasmNodeConnection } from "./test-wasm-node.js";

describe("toDuckDbParams", () => {
  it("passes strings, numbers, booleans and null through", () => {
    expect(toDuckDbParams(["a", 1, 1.5, true, null])).toEqual(["a", 1, 1.5, true, null]);
  });

  it("binds undefined as null", () => {
    expect(toDuckDbParams([undefined])).toEqual([null]);
  });

  it("binds bigint as its exact decimal string", () => {
    expect(toDuckDbParams([5n, -9007199254740993n])).toEqual(["5", "-9007199254740993"]);
  });

  it("binds Date as an ISO string", () => {
    expect(toDuckDbParams([new Date("2024-01-02T03:04:05.123Z")])).toEqual([
      "2024-01-02T03:04:05.123Z",
    ]);
  });

  it("rejects an invalid Date", () => {
    expect(() => toDuckDbParams([new Date("nope")])).toThrow(/parameter \$1.*invalid Date/);
  });

  it.each([
    ["Uint8Array", new Uint8Array([1]), /parameter \$2.*Uint8Array/],
    ["array", [1, 2], /parameter \$2.*array/],
    ["object", { a: 1 }, /parameter \$2.*object/],
    ["NaN", Number.NaN, /parameter \$2.*NaN/],
    ["Infinity", Number.POSITIVE_INFINITY, /parameter \$2.*Infinity/],
    ["symbol", Symbol("s"), /parameter \$2.*symbol/],
    ["function", () => 1, /parameter \$2.*function/],
  ])("rejects %s with an error naming the type", (_name, value, pattern) => {
    expect(() => toDuckDbParams(["ok", value])).toThrow(pattern);
  });
});

/** Converted params bound through duckdb-wasm itself (Node blocking bindings). */
describe("toDuckDbParams with duckdb-wasm", () => {
  let conn: DuckDBConnection;

  beforeAll(async () => {
    conn = await openWasmNodeConnection();
    conn.query("CREATE TABLE t (id BIGINT, d DATE, ts TIMESTAMP, n VARCHAR)");
    conn.query(`INSERT INTO t VALUES
      (9007199254740993, DATE '2024-01-02', TIMESTAMP '2024-01-02 03:04:05', 'a'),
      (5, DATE '2024-01-03', TIMESTAMP '2024-01-03 00:00:00', 'b')`);
  });

  function query(sql: string, params: unknown[]): Record<string, unknown>[] {
    const stmt = conn.prepare(sql);
    try {
      return arrowTableToObjects(stmt.query(...toDuckDbParams(params)));
    } finally {
      stmt.close();
    }
  }

  it("matches a BIGINT column with a bigint beyond 2^53", () => {
    expect(query("SELECT n FROM t WHERE id = $1", [9007199254740993n])).toEqual([{ n: "a" }]);
  });

  it("round-trips a fetched BIGINT id", () => {
    const [first] = query("SELECT id FROM t WHERE n = $1", ["b"]);
    expect(first?.id).toBe(5n);
    expect(query("SELECT n FROM t WHERE id = $1", [first?.id])).toEqual([{ n: "b" }]);
  });

  it("inserts a bigint into a BIGINT column exactly", () => {
    query("INSERT INTO t (id, n) VALUES ($1, $2)", [9007199254740995n, "c"]);
    expect(query("SELECT id FROM t WHERE n = $1", ["c"])).toEqual([{ id: 9007199254740995n }]);
  });

  it("works with an explicit cast where the type is not inferred", () => {
    expect(query("SELECT $1::BIGINT + 1 AS x", [9007199254740993n])).toEqual([
      { x: 9007199254740994n },
    ]);
  });

  it("compares a Date against a TIMESTAMP column", () => {
    expect(query("SELECT n FROM t WHERE ts = $1", [new Date("2024-01-02T03:04:05.000Z")])).toEqual([
      { n: "a" },
    ]);
    expect(
      query("SELECT n FROM t WHERE ts < $1 ORDER BY n", [new Date("2024-01-03T00:00:00Z")]),
    ).toEqual([{ n: "a" }]);
  });
});
