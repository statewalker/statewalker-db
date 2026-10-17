import { describe, expect, it } from "vitest";
import { encodeGram, gramsOf, trigrams } from "./trigrams.js";

describe("trigrams", () => {
  it("returns distinct folded 3-code-point grams in order of first appearance", () => {
    expect(trigrams("Hello")).toEqual(["hel", "ell", "llo"]);
    expect(trigrams("aaaa")).toEqual(["aaa"]);
  });

  it("returns nothing for texts shorter than 3 code points", () => {
    expect(trigrams("ab")).toEqual([]);
    expect(trigrams("😀😀")).toEqual([]);
  });

  it("never splits a surrogate pair", () => {
    expect(trigrams("😀abc")).toEqual(["😀ab", "abc"]);
  });
});

describe("encodeGram", () => {
  it("encodes BMP grams exactly and astral grams above 2^48, all as safe integers", () => {
    const bmp = encodeGram("abc");
    expect(bmp).toBe(0x61 * 2 ** 32 + 0x62 * 2 ** 16 + 0x63);
    const astral = encodeGram(gramsOf("😀ab")[0] ?? "");
    expect(astral).toBeGreaterThanOrEqual(2 ** 48);
    expect(Number.isSafeInteger(astral)).toBe(true);
  });
});
