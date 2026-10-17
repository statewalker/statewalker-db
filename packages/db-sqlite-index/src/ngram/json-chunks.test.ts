import { describe, expect, it } from "vitest";
import { chunkJson } from "./json-chunks.js";

describe("chunkJson", () => {
  const rows = Array.from({ length: 30 }, (_, i) => [i, `t${i}`]);

  it("splits into chunks of at most maxChars that rebuild the rows in order", () => {
    const chunks = chunkJson(rows, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
    expect(chunks.flatMap((chunk) => JSON.parse(chunk))).toEqual(rows);
  });

  it("keeps a row larger than maxChars as one chunk of its own", () => {
    const big = [1, "x".repeat(50)];
    const chunks = chunkJson([[0, "a"], big, [2, "b"]], 20);
    expect(chunks).toEqual(['[[0,"a"]]', JSON.stringify([big]), '[[2,"b"]]']);
  });

  it("returns no chunks for no rows", () => {
    expect(chunkJson([], 20)).toEqual([]);
  });
});
