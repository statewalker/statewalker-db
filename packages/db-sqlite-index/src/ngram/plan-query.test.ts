import { describe, expect, it } from "vitest";
import { fold } from "./fold.js";
import { MAX_PATTERN_LENGTH, planQuery } from "./plan-query.js";
import { gramsOf, trigrams } from "./trigrams.js";

const REGEX_TABLE: Array<[string, string[][] | null]> = [
  ["abc", [["abc"]]],
  ["abc(def|ghi)", [["abcdef"], ["abcghi"]]],
  ["abc.*def", [["abc", "def"]]],
  [
    "abc.*(def|ghi)",
    [
      ["abc", "def"],
      ["abc", "ghi"],
    ],
  ],
  ["a+hello", [["hello"]]],
  ["(abc)(def)", [["abcdef"]]],
  ["[ab][cd][ef]", [["ace"], ["acf"], ["ade"], ["adf"], ["bce"], ["bcf"], ["bde"], ["bdf"]]],
  ["ab[cd]e", [["abce"], ["abde"]]],
  ["a.b", null],
  ["[a-z]{3}", null],
  ["foo|bar", [["foo"], ["bar"]]],
  ["foo|.+", null],
  ["(abc)*$", null],
  ["abc+de", [["abc"]]],
  ["ab{2}c", [["abbc"]]],
  ["ab{2,}c", [["abb"]]],
  ["a?bcd", [["bcd"]]],
  ["qua(?!foo)", [["qua"]]],
  ["/\\d+/-\\d", null],
  ["x\\.y\\.z", [["x.y.z"]]],
  ["\\x41BC", [["abc"]]],
  ["(a{10}|b{10}|c{10}){10}", [["aaaaaaaaaa"], ["bbbbbbbbbb"], ["cccccccccc"]]],
  ["(?:abc|abd)ef", [["abcef"], ["abdef"]]],
  ["(?<n>abc)def", [["abcdef"]]],
  ["a(?=bcd)", null],
  ["[^abc]def", [["def"]]],
  ["\\bword\\b", [["word"]]],
  ["[abc]{3}[def]{3}", null],
  ["[qwerty]{2}-?[qwerty]{2}", null],
  ["[^]|abc]def", null],
];

// A string each pattern matches (and, below, the counterexamples to gluing arms).
const MATCHES: Array<[string, string]> = [
  ["abc", "xabcx"],
  ["abc(def|ghi)", "abcghi"],
  ["abc.*def", "abc--def"],
  ["abc.*(def|ghi)", "abcZghi"],
  ["a+hello", "aaahello"],
  ["(abc)(def)", "abcdef"],
  ["[ab][cd][ef]", "bdf"],
  ["ab[cd]e", "abde"],
  ["a.b", "aXb"],
  ["[a-z]{3}", "xyz"],
  ["foo|bar", "bar"],
  ["foo|.+", "zzz"],
  ["(abc)*$", "abcabc"],
  ["abc+de", "abccde"],
  ["ab{2}c", "abbc"],
  ["ab{2,}c", "abbbc"],
  ["a?bcd", "bcd"],
  ["qua(?!foo)", "quab"],
  ["/\\d+/-\\d", "/12/-3"],
  ["x\\.y\\.z", "x.y.z"],
  ["\\x41BC", "ABC"],
  ["(a{10}|b{10}|c{10}){10}", "c".repeat(100)],
  ["(?:abc|abd)ef", "abdef"],
  ["(?<n>abc)def", "abcdef"],
  ["a(?=bcd)", "abcd"],
  ["[^abc]def", "zdef"],
  ["\\bword\\b", "a word."],
  ["[abc]{3}[def]{3}", "cabfed"],
  ["[qwerty]{2}-?[qwerty]{2}", "qw-er"],
  ["[^]|abc]def", "x"],
  ["x(.abc)", "xZabc"],
  ["(abc.)def", "abcXdef"],
  ["xy(a*bcd)", "xyabcd"],
  ["foo(bar|.baz)", "fooXbaz"],
  ["(\\dabc)def", "1abcdef"],
  ["x(a+)bcd", "xaabcd"],
  ["(?<=abc)def", "abcdef"],
  ["\\u{1F600}abc", "u{1F600}abc"],
  ["x\\u{3}yz", "xuuuyz"],
  ["[😀]abc", "😀abc"],
];

describe("planQuery (regex)", () => {
  it.each(REGEX_TABLE)("%s", (pattern, expected) => {
    expect(planQuery(pattern, { regex: true }).branches).toEqual(expected);
  });

  it.each(MATCHES)("never rejects a string that %s matches: %s", (pattern, text) => {
    expect(new RegExp(pattern).test(text)).toBe(true);
    const { branches } = planQuery(pattern, { regex: true });
    const folded = fold(text);
    const grams = new Set(trigrams(text));
    const covered = (b: string[]) =>
      b.every((l) => folded.includes(l) && gramsOf(l).every((g) => grams.has(g)));
    expect(branches === null || branches.some(covered)).toBe(true);
  });

  it("folds literals whatever the case sensitivity", () => {
    expect(planQuery("DEF", { regex: true }).branches).toEqual([["def"]]);
    expect(planQuery("DEF", { regex: true, caseSensitive: false }).branches).toEqual([["def"]]);
  });

  it("builds a global regex, case-insensitive only on request", () => {
    expect(planQuery("abc").regex.flags).toBe("g");
    expect(planQuery("abc", { caseSensitive: false }).regex.flags).toBe("gi");
  });

  it("rejects an invalid regex with the engine's SyntaxError", () => {
    expect(() => planQuery("(abc", { regex: true })).toThrow(SyntaxError);
  });
});

describe("planQuery (literal)", () => {
  it("treats regex syntax as text", () => {
    expect(planQuery("a.b*c").branches).toEqual([["a.b*c"]]);
    expect(planQuery("a.b*c").regex.test("xa.b*cx")).toBe(true);
  });

  it("needs a scan below 3 code points, counting an astral character as one", () => {
    expect(planQuery("ab").branches).toBeNull();
    expect(planQuery("😀a").branches).toBeNull();
    expect(planQuery("😀ab").branches).toEqual([["😀ab"]]);
  });

  it("rejects patterns over the length cap", () => {
    expect(() => planQuery("a".repeat(MAX_PATTERN_LENGTH + 1))).toThrow(/limit is 1000/);
  });
});
