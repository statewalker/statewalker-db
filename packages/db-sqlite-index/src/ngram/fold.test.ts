import { describe, expect, it } from "vitest";
import { fold } from "./fold.js";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

describe("fold", () => {
  it("lower-cases ASCII and keeps length", () => {
    expect(fold("Hello WORLD")).toBe("hello world");
  });

  it("maps every case form of sigma to one letter", () => {
    expect(new Set([fold("Σ"), fold("σ"), fold("ς")]).size).toBe(1);
  });

  it("never separates two BMP characters that a case-insensitive regex treats as equal", () => {
    const broken: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCharCode(cp);
      const re = new RegExp(`^${escapeRegex(c)}$`, "i");
      for (const d of [c.toUpperCase(), c.toLowerCase()]) {
        if (d === c || d.length !== 1 || !re.test(d)) continue;
        if (fold(c) !== fold(d)) broken.push(`U+${cp.toString(16)} ${c}/${d}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("keeps the UTF-16 length of every code point, so offsets stay valid", () => {
    const changed: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (fold(c).length !== c.length) changed.push(`U+${cp.toString(16)}`);
    }
    expect(changed).toEqual([]);
  });

  it("keeps the length of a text with U+0130 and an astral character", () => {
    const folded = fold("İ😀A");
    expect(folded.length).toBe("İ😀A".length);
    expect(folded.endsWith("a")).toBe(true);
  });

  it("is a homomorphism over concatenation, so substrings stay substrings", () => {
    const a = "ΟΔΟΣ ſtraße";
    const b = "İK";
    expect(fold(a + b)).toBe(fold(a) + fold(b));
  });
});
