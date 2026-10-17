import { describe, expect, it } from "vitest";
import { MAX_PATTERN_LENGTH, planQuery } from "./plan-query.js";

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
];

describe("planQuery (regex)", () => {
  it.each(REGEX_TABLE)("%s", (pattern, expected) => {
    expect(planQuery(pattern, { regex: true }).branches).toEqual(expected);
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
