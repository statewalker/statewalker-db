import { fold } from "./fold.js";
import { regexLiterals } from "./regex-literals.js";

/** Longer patterns are rejected: a JS regex cannot be interrupted once it runs. */
export const MAX_PATTERN_LENGTH = 1000;

export type QueryPlan = {
  /** The pattern as a global regex (`i` added when not case-sensitive); verifies candidates. */
  regex: RegExp;
  /**
   * Per DNF branch, the folded literals of at least 3 code points that a match must
   * contain. `null` when some branch has none: only a scan can answer the pattern.
   */
  branches: string[][] | null;
};

export function planQuery(
  pattern: string,
  opts: { regex?: boolean; caseSensitive?: boolean } = {},
): QueryPlan {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new RangeError(
      `ngram: pattern is ${pattern.length} characters, the limit is ${MAX_PATTERN_LENGTH}`,
    );
  }
  const source = opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const regex = new RegExp(source, opts.caseSensitive === false ? "gi" : "g");
  const branches: string[][] = [];
  for (const literals of regexLiterals(regex)) {
    const usable = literals.map(fold).filter((literal) => Array.from(literal).length >= 3);
    if (usable.length === 0) return { regex, branches: null };
    branches.push(usable);
  }
  return { regex, branches };
}
