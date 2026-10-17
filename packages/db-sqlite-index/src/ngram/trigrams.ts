import { fold } from "./fold.js";

/** Distinct 3-code-point grams of an already folded string, in first-seen order. */
export function gramsOf(folded: string): string[] {
  const cps = Array.from(folded);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= cps.length; i++) out.add(cps.slice(i, i + 3).join(""));
  return [...out];
}

/** Distinct trigrams of `text` as the index sees it: case-folded, by code point. */
export function trigrams(text: string): string[] {
  return gramsOf(fold(text));
}

/**
 * One SQLite INTEGER per gram. Three BMP code points pack exactly into 48 bits.
 * A gram with an astral code point keeps the low 16 bits of each code point
 * above 2^48: a collision only adds candidates, which verification removes.
 */
export function encodeGram(gram: string): number {
  const [a = 0, b = 0, c = 0] = Array.from(gram, (ch) => ch.codePointAt(0) ?? 0);
  if (a < 0x10000 && b < 0x10000 && c < 0x10000) return a * 2 ** 32 + b * 2 ** 16 + c;
  return 2 ** 48 + (a % 0x10000) * 2 ** 32 + (b % 0x10000) * 2 ** 16 + (c % 0x10000);
}
