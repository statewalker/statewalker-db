/**
 * Case fold per code point, applied to indexed text and to query literals alike.
 *
 * Upper-then-lower maps every character a case-insensitive JS regex treats as
 * equal to one form (Σ σ ς → σ, ſ → s). A character whose upper case is several
 * code points (ß → SS) only matches itself under `/i`, so it keeps its own
 * lower case. Folding per code point makes fold(a + b) === fold(a) + fold(b), so
 * a substring of the text stays a substring of the folded text. A character
 * whose folded form has a different UTF-16 length (İ → i + U+0307) is kept as
 * is, so fold preserves the length and offsets into the folded text are
 * offsets into the original.
 */
export function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const upper = ch.toUpperCase();
    const lower = (Array.from(upper).length === 1 ? upper : ch).toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/**
 * Highest code point probed by `foldIdentity`. Every cased character is in the
 * BMP or the SMP (Deseret, Osage, Adlam, …); planes 2 and up hold none.
 */
const PROBE_END = 0x1ffff;
const IDENTITY_VERSION = "fold-v1";
let current: string | undefined;

/**
 * A fingerprint of what `foldFn` does to every code point up to U+1FFFF: a
 * 53-bit hash of each code point it changes and what it changes it to. The
 * grams of an n-gram index are built with `fold`, and a contentless FTS5 row is
 * deleted by replaying them, so a runtime whose case mappings differ (a newer
 * Unicode in a newer V8 or ICU) yields a different identity, and the store
 * rebuilds its grams. It needs no runtime API, so it works in Node, browsers
 * and Durable Objects alike. The identity of `fold` is computed once (about
 * 30 ms) and memoized.
 */
export function foldIdentity(foldFn: (text: string) => string = fold): string {
  if (foldFn === fold && current !== undefined) return current;
  // cyrb53: two 32-bit FNV-style lanes mixed into 53 bits.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const mix = (value: number) => {
    h1 = Math.imul(h1 ^ value, 2654435761);
    h2 = Math.imul(h2 ^ value, 1597334677);
  };
  for (let cp = 0; cp <= PROBE_END; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const folded = foldFn(ch);
    if (folded === ch) continue;
    mix(cp);
    for (let i = 0; i < folded.length; i++) mix(folded.charCodeAt(i));
    mix(0x110000); // separator: the folded form of one code point may be several units
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  const identity = `${IDENTITY_VERSION}:${hash.toString(16)}`;
  if (foldFn === fold) current = identity;
  return identity;
}
