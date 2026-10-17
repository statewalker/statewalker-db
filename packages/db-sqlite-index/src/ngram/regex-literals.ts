/*
 * Mandatory-literal extraction from a regex, after Russ Cox's trigram method.
 * Ported from hypgrep 0.5.3 src/regex.js (Hyperparam), MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following
 * conditions: The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */

/** Cross-product cap: past it, the construct counts as a wildcard. */
const MAX_DNF = 32;

type LiveBranch = { literals: string[]; run: string };
type Quantifier = { copies: number; openEnded: boolean; end: number };
type GroupPrefix = { kind: "consuming"; innerStart: number } | { kind: "assertion" | "unknown" };

/**
 * DNF of literals that every match must contain: a string can match only if all
 * literals of at least one branch occur in it. An empty branch matches anything.
 * Conservative: a construct it cannot reason about becomes a wildcard, never a literal.
 *
 *   /abc(def|ghi)/ → [["abcdef"], ["abcghi"]]   /foo|.+/ → [["foo"], []]
 */
export function regexLiterals(regex: RegExp): string[][] {
  // v-mode class syntax desyncs skipClass and would invent literals.
  if (regex.flags.includes("v")) return [[]];
  return expandRegion(regex.source, 0, regex.source.length);
}

function expandRegion(src: string, start: number, end: number): string[][] {
  const dnf: string[][] = [];
  for (const [bStart, bEnd] of splitTopLevelAlternation(src, start, end)) {
    for (const branch of expandBranch(src, bStart, bEnd)) dnf.push(branch);
  }
  return dnf;
}

function splitTopLevelAlternation(
  src: string,
  start: number,
  end: number,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let bStart = start;
  let depth = 0;
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      i = skipClass(src, i);
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "|" && depth === 0) {
      spans.push([bStart, i]);
      bStart = i + 1;
    }
    i += 1;
  }
  spans.push([bStart, end]);
  return spans;
}

function expandBranch(src: string, start: number, end: number): string[][] {
  let cross: LiveBranch[] = [{ literals: [], run: "" }];
  const flushRuns = () => {
    for (const b of cross) {
      if (b.run.length > 0) {
        b.literals.push(b.run);
        b.run = "";
      }
    }
  };
  // Append `text` repeated by the quantifier's mandatory copies to every live run.
  const appendRun = (text: string, q: Quantifier) => {
    if (q.copies === 0) {
      flushRuns();
      return;
    }
    for (const b of cross) b.run += text.repeat(q.copies);
    if (q.openEnded) flushRuns();
  };

  let i = start;
  while (i < end) {
    const c = src[i] ?? "";

    if (c === "^" || c === "$") {
      i += 1;
      continue;
    }

    if (c === "\\") {
      const next = src[i + 1];
      if (next === undefined) {
        i += 1;
        continue;
      }
      const escaped = parseEscapedLiteral(src, i);
      if (escaped) {
        const q = peekQuantifier(src, escaped.end);
        i = q.end;
        appendRun(escaped.char, q);
        continue;
      }
      // \d \w \s \b, backrefs, \p{…}: a wildcard; consume its payload.
      if (/[a-zA-Z0-9]/.test(next)) {
        flushRuns();
        i = peekQuantifier(src, skipSpecialEscape(src, i)).end;
        continue;
      }
      // \. \/ \( …: the literal character.
      const q = peekQuantifier(src, i + 2);
      i = q.end;
      appendRun(next, q);
      continue;
    }

    if (c === "[") {
      const classEnd = skipClass(src, i);
      const chars = parseLiteralClass(src, i, classEnd);
      const q = peekQuantifier(src, classEnd);
      i = q.end;
      if (
        q.copies === 0 ||
        chars === null ||
        q.copies > 1 ||
        cross.length * chars.length > MAX_DNF
      ) {
        flushRuns();
        continue;
      }
      cross = cross.flatMap((b) =>
        chars.map((ch) => ({ literals: b.literals.slice(), run: b.run + ch })),
      );
      if (q.openEnded) flushRuns();
      continue;
    }

    if (c === "(") {
      const groupEnd = skipGroup(src, i);
      const group = parseGroupPrefix(src, i);
      const q = peekQuantifier(src, groupEnd);
      i = q.end;
      if (group.kind !== "consuming" || q.copies === 0) {
        flushRuns();
        continue;
      }
      const inner = expandRegion(src, group.innerStart, groupEnd - 1);
      // Fold into the run only when every arm is one contiguous literal used once:
      // a repeated group (`(a|b){3}`) may pick different arms per copy.
      const foldable = q.copies === 1 && inner.length > 0 && inner.every((b) => b.length === 1);
      if (foldable && cross.length * inner.length <= MAX_DNF) {
        cross = cross.flatMap((b) =>
          inner.map((arm) => ({ literals: b.literals.slice(), run: b.run + (arm[0] ?? "") })),
        );
        if (q.openEnded) flushRuns();
        continue;
      }
      flushRuns();
      if (cross.length * inner.length > MAX_DNF) continue;
      cross = cross.flatMap((b) =>
        inner.map((arm) => ({ literals: b.literals.concat(arm), run: "" })),
      );
      continue;
    }

    if (c === ".") {
      flushRuns();
      i = peekQuantifier(src, i + 1).end;
      continue;
    }

    const q = peekQuantifier(src, i + 1);
    i = q.end;
    appendRun(c, q);
  }
  flushRuns();
  return cross.map((b) => b.literals);
}

/** Where a group's consuming body starts; lookarounds and unknown `(?…)` are not consuming. */
function parseGroupPrefix(src: string, start: number): GroupPrefix {
  if (src[start + 1] !== "?") return { kind: "consuming", innerStart: start + 1 };
  const marker = src[start + 2];
  if (marker === ":") return { kind: "consuming", innerStart: start + 3 };
  if (marker === "=" || marker === "!") return { kind: "assertion" };
  if (marker === "<") {
    const next = src[start + 3];
    if (next === "=" || next === "!") return { kind: "assertion" };
    const nameEnd = src.indexOf(">", start + 3);
    if (nameEnd >= 0) return { kind: "consuming", innerStart: nameEnd + 1 };
  }
  return { kind: "unknown" };
}

/** `\xHH`, `\uHHHH`, `\u{H…}`: escapes that stand for one literal character. */
function parseEscapedLiteral(
  src: string,
  start: number,
): { char: string; end: number } | undefined {
  const kind = src[start + 1];
  if (kind === "x") {
    const hex = src.slice(start + 2, start + 4);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
    return { char: String.fromCharCode(Number.parseInt(hex, 16)), end: start + 4 };
  }
  if (kind === "u") {
    if (src[start + 2] === "{") {
      const close = src.indexOf("}", start + 3);
      if (close < 0) return undefined;
      const hex = src.slice(start + 3, close);
      if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) return undefined;
      return { char: String.fromCodePoint(codePoint), end: close + 1 };
    }
    const hex = src.slice(start + 2, start + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
    return { char: String.fromCharCode(Number.parseInt(hex, 16)), end: start + 6 };
  }
  return undefined;
}

/**
 * Skip an escape that is not a literal punctuation character, so its payload
 * (`\x41`, `\p{L}`, `\k<name>`, backrefs) never leaks into a literal. Malformed
 * `\x`, `\u`, `\c` payloads are Annex-B literals and are rescanned as atoms.
 */
function skipSpecialEscape(src: string, start: number): number {
  const next = src[start + 1];
  if (next === "x") {
    return /^[0-9a-fA-F]{2}$/.test(src.slice(start + 2, start + 4)) ? start + 4 : start + 2;
  }
  if (next === "u") {
    if (src[start + 2] === "{") {
      const close = src.indexOf("}", start + 3);
      return close >= 0 ? close + 1 : src.length;
    }
    return /^[0-9a-fA-F]{4}$/.test(src.slice(start + 2, start + 6)) ? start + 6 : start + 2;
  }
  if (next === "c") return /^[a-zA-Z]$/.test(src[start + 2] ?? "") ? start + 3 : start + 2;
  if ((next === "p" || next === "P") && src[start + 2] === "{") {
    const close = src.indexOf("}", start + 3);
    return close >= 0 ? close + 1 : src.length;
  }
  if (next === "k" && src[start + 2] === "<") {
    const close = src.indexOf(">", start + 3);
    return close >= 0 ? close + 1 : src.length;
  }
  if (/[0-9]/.test(next ?? "")) {
    let i = start + 2;
    while (/[0-9]/.test(src[i] ?? "")) i += 1;
    return i;
  }
  return Math.min(start + 2, src.length);
}

/** A `[...]` class as literal alternatives, or null if negated, ranged, special or empty. */
function parseLiteralClass(src: string, start: number, end: number): string[] | null {
  let i = start + 1;
  const lastInside = end - 1;
  if (src[i] === "^") return null;
  const chars = new Set<string>();
  while (i < lastInside) {
    const c = src[i] ?? "";
    if (c === "\\") {
      const next = src[i + 1];
      if (next === undefined || /[a-zA-Z]/.test(next)) return null;
      chars.add(next);
      i += 2;
      continue;
    }
    if (i + 2 < lastInside && src[i + 1] === "-") return null;
    chars.add(c);
    i += 1;
  }
  return chars.size === 0 ? null : [...chars];
}

/** Mandatory copies of the preceding atom, whether more may follow, and where the quantifier ends. */
function peekQuantifier(src: string, i: number): Quantifier {
  const c = src[i];
  if (c === "?" || c === "*" || c === "+") {
    const end = src[i + 1] === "?" ? i + 2 : i + 1;
    return { copies: c === "+" ? 1 : 0, openEnded: true, end };
  }
  if (c === "{") {
    const close = src.indexOf("}", i);
    if (close < 0) return { copies: 1, openEnded: false, end: i };
    const m = /^(\d+)(?:,(\d*))?$/.exec(src.slice(i + 1, close));
    if (!m) return { copies: 1, openEnded: false, end: i };
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[2] === "" ? Number.POSITIVE_INFINITY : Number(m[2]);
    const end = src[close + 1] === "?" ? close + 2 : close + 1;
    return { copies: min, openEnded: max > min, end };
  }
  return { copies: 1, openEnded: false, end: i };
}

function skipClass(src: string, i: number): number {
  let j = i + 1;
  if (src[j] === "^") j += 1;
  if (src[j] === "]") j += 1;
  while (j < src.length && src[j] !== "]") j += src[j] === "\\" && j + 1 < src.length ? 2 : 1;
  return j < src.length ? j + 1 : j;
}

function skipGroup(src: string, i: number): number {
  let depth = 1;
  let j = i + 1;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === "\\" && j + 1 < src.length) {
      j += 2;
      continue;
    }
    if (c === "[") {
      j = skipClass(src, j);
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    j += 1;
  }
  return j;
}
