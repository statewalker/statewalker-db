/**
 * Case fold per code point, applied to indexed text and to query literals alike.
 *
 * Upper-then-lower maps every character a case-insensitive JS regex treats as
 * equal to one form (Σ σ ς → σ, ſ → s). A character whose upper case is several
 * code points (ß → SS) only matches itself under `/i`, so it keeps its own
 * lower case. Folding per code point makes fold(a + b) === fold(a) + fold(b), so
 * a substring of the text stays a substring of the folded text.
 */
export function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const upper = ch.toUpperCase();
    out += (Array.from(upper).length === 1 ? upper : ch).toLowerCase();
  }
  return out;
}
