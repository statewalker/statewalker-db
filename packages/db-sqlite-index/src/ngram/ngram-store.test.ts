import type { Db } from "@statewalker/db-api";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type NgramItem, type NgramSearchOptions, NgramStore } from "./index.js";

const DRIVERS: Array<[string, () => Promise<Db>]> = [
  ["node:sqlite", () => newNodeSqliteDb()],
  ["do (fake storage)", async () => newDoSqliteDb(newFakeDoStorage())],
];
const STORES = ["fts5"] as const;

const UNLIMITED: NgramSearchOptions = { limit: 1e9, candidateBudget: 1e9 };

/** The oracle: the same pattern over every text, no index. */
function scan(items: NgramItem[], pattern: string, opts: NgramSearchOptions = {}) {
  const source = opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(source, opts.caseSensitive === false ? "gi" : "g");
  return items
    .map(({ id, text }) => ({
      id,
      matches: [...text.matchAll(re)]
        .filter((m) => m[0].length > 0)
        .map((m) => ({ start: m.index, end: m.index + m[0].length })),
    }))
    .filter((hit) => hit.matches.length > 0)
    .sort((a, b) => a.id - b.id);
}

const items = (texts: string[]): NgramItem[] => texts.map((text, i) => ({ id: i + 1, text }));

/** Same rows as pg_trgm's contrib/pg_trgm/data/trgm.data. */
const TRGM = items(
  Array.from({ length: 1000 }, (_, i) => `qwertyu${String(i + 1).padStart(4, "0")}`),
);
/** Same rows as pg_trgm's test2 table. */
const TEST2 = items([
  "abcdef",
  "quark",
  "  z foo bar",
  "/123/-45/",
  "line 1",
  "%line 2",
  "line 3%",
  "%line 4%",
  "%li%ne 5%",
  "li_e 6",
]);
const UNICODE = items([
  "Straße und STRASSE",
  "ſtraße",
  "ΟΔΟΣ οδός ΟΔΟΣ",
  "😀abc😀 x😀y",
  "東京タワー と 東京駅",
  "İstanbul istanbul",
  "Kelvin K and k",
  "ẞ ß ss",
]);

type Query = [string, NgramItem[], string, NgramSearchOptions];
const QUERIES: Query[] = [
  ["trgm", TRGM, "[qwerty]{2}-?[qwerty]{2}", { regex: true }],
  ["trgm", TRGM, "99", {}],
  ["trgm", TRGM, "qwerty", {}],
  ["trgm", TRGM, "qw", {}],
  ["trgm", TRGM, "u0988", {}],
  ["trgm", TRGM, "0(1|2)3", { regex: true }],
  ["trgm", TRGM, "ty.*99", { regex: true }],
  ["test2", TEST2, "BCD", {}],
  ["test2", TEST2, "bcd", {}],
  ["test2", TEST2, "BCD", { caseSensitive: false }],
  ["test2", TEST2, "\\bcd", {}],
  ["test2", TEST2, "z foo bar", {}],
  ["test2", TEST2, "  z foo", {}],
  ["test2", TEST2, "%", {}],
  ["test2", TEST2, "li_e", {}],
  ["test2", TEST2, "%li%", {}],
  ["test2", TEST2, "[abc]{3}", { regex: true }],
  ["test2", TEST2, "a[bc]+d", { regex: true }],
  ["test2", TEST2, "(abc)*$", { regex: true }],
  ["test2", TEST2, "DEF", { regex: true, caseSensitive: false }],
  ["test2", TEST2, "dEf", { regex: true }],
  ["test2", TEST2, "^q", { regex: true, caseSensitive: false }],
  ["test2", TEST2, "[abc]{3}[def]{3}", { regex: true, caseSensitive: false }],
  ["test2", TEST2, "ab[a-z]{3}", { regex: true, caseSensitive: false }],
  ["test2", TEST2, "(^| )qua", { regex: true, caseSensitive: false }],
  ["test2", TEST2, "q.*rk$", { regex: true }],
  ["test2", TEST2, "q", { regex: true }],
  ["test2", TEST2, "[a-z]{3}", { regex: true }],
  ["test2", TEST2, "(a{10}|b{10}|c{10}){10}", { regex: true, caseSensitive: false }],
  ["test2", TEST2, " z foo bar", { regex: true }],
  ["test2", TEST2, "qua(?!foo)", { regex: true }],
  ["test2", TEST2, "/\\d+/-\\d", { regex: true }],
  ["short", TEST2, "", {}],
  ["short", TEST2, "a", {}],
  ["short", TEST2, "ab", {}],
  ["short", TEST2, "^", { regex: true }],
  ["unicode", UNICODE, "straße", {}],
  ["unicode", UNICODE, "STRASSE", { caseSensitive: false }],
  ["unicode", UNICODE, "ß", {}],
  ["unicode", UNICODE, "ẞ", { caseSensitive: false }],
  ["unicode", UNICODE, "ΟΔΟΣ", { caseSensitive: false }],
  ["unicode", UNICODE, "οδοσ", { caseSensitive: false }],
  ["unicode", UNICODE, "😀", {}],
  ["unicode", UNICODE, "😀a", {}],
  ["unicode", UNICODE, "abc😀", {}],
  ["unicode", UNICODE, "東京", {}],
  ["unicode", UNICODE, "東京駅", {}],
  ["unicode", UNICODE, "istanbul", { caseSensitive: false }],
  ["unicode", UNICODE, "kelvin K", { caseSensitive: false }],
];

for (const [driverName, newDb] of DRIVERS) {
  for (const store of STORES) {
    describe(`NgramStore ${store} on ${driverName}`, () => {
      let db: Db;
      let index: NgramStore;

      beforeEach(async () => {
        db = await newDb();
        index = new NgramStore({ db, prefix: "t_", store });
        await index.init();
      });
      /**
       * Whether the index still yields a candidate for `literal` (3+ code points).
       * With a zero budget, any candidate sets `truncated`; verification cannot hide
       * stale grams here, which is how the write guards are pinned.
       */
      const indexed = async (literal: string) =>
        (await index.search(literal, { candidateBudget: 0 })).truncated;
      afterEach(async () => {
        await db.close();
      });

      it.each(QUERIES)("%s: %s %j equals a brute-force scan", async (_c, corpus, pattern, o) => {
        await index.upsert(corpus);
        const result = await index.search(pattern, { ...o, ...UNLIMITED });
        expect(result.hits).toEqual(scan(corpus, pattern, o));
        expect(result.truncated).toBe(false);
      });

      it("reports UTF-16 offsets in astral text", async () => {
        await index.upsert([{ id: 7, text: "😀abc😀" }]);
        const { hits } = await index.search("abc");
        expect(hits).toEqual([{ id: 7, matches: [{ start: 2, end: 5 }] }]);
      });

      it("upsert replaces the text: old content stops matching", async () => {
        await index.upsert([{ id: 1, text: "alpha beta" }]);
        await index.upsert([{ id: 1, text: "gamma delta" }]);
        expect((await index.search("alpha")).hits).toEqual([]);
        expect(await indexed("alpha")).toBe(false);
        expect((await index.search("gamma")).hits.map((h) => h.id)).toEqual([1]);
      });

      it("duplicate ids in one upsert keep the last text", async () => {
        await index.upsert([
          { id: 1, text: "first version" },
          { id: 1, text: "second version" },
        ]);
        expect((await index.search("first")).hits).toEqual([]);
        expect(await indexed("first")).toBe(false);
        expect((await index.search("version")).hits.map((h) => h.id)).toEqual([1]);
        await index.delete([1]);
        expect((await index.search("version")).hits).toEqual([]);
        expect(await indexed("version")).toBe(false);
      });

      it("delete removes items from index and scan", async () => {
        await index.upsert(items(["one two", "two three"]));
        await index.delete([1]);
        expect((await index.search("two")).hits.map((h) => h.id)).toEqual([2]);
        expect(await indexed("one")).toBe(false);
        expect((await index.search("o", {})).hits.map((h) => h.id)).toEqual([2]);
      });

      it("upserts a batch larger than one JSON parameter", async () => {
        const big = Array.from({ length: 3000 }, (_, i) => ({
          id: i + 1,
          text: `${"lorem ipsum ".repeat(33)}marker${String(i).padStart(5, "0")}`,
        }));
        await index.upsert(big);
        expect((await index.search("marker02999")).hits.map((h) => h.id)).toEqual([3000]);
      });

      it("a second store on the same db and prefix sees persisted data", async () => {
        await index.upsert(items(["persisted text"]));
        const reopened = new NgramStore({ db, prefix: "t_", store });
        await reopened.init();
        expect((await reopened.search("persisted")).hits.map((h) => h.id)).toEqual([1]);
      });

      it("limit stops early and reports truncation", async () => {
        await index.upsert(TRGM);
        const result = await index.search("qwerty", { limit: 5 });
        expect(result.hits.map((h) => h.id)).toEqual([1, 2, 3, 4, 5]);
        expect(result.truncated).toBe(true);
      });

      it("candidateBudget caps verified candidates and reports truncation", async () => {
        await index.upsert(TRGM);
        const result = await index.search("qwerty", { candidateBudget: 10, limit: 1e9 });
        expect(result.hits).toHaveLength(10);
        expect(result.truncated).toBe(true);
      });

      it("filter drops candidates before verification", async () => {
        await index.upsert(TRGM);
        const result = await index.search("qwertyu09", { filter: (id) => id % 2 === 0 });
        expect(result.hits.map((h) => h.id)).toEqual(
          scan(TRGM, "qwertyu09")
            .map((h) => h.id)
            .filter((id) => id % 2 === 0),
        );
      });

      it("an aborted signal rejects with its reason", async () => {
        await index.upsert(TRGM);
        const controller = new AbortController();
        controller.abort(new Error("stop"));
        await expect(index.search("qwerty", { signal: controller.signal })).rejects.toThrow("stop");
      });

      it("rejects an over-long pattern and an invalid regex", async () => {
        await expect(index.search("x".repeat(1001))).rejects.toThrow(/limit is 1000/);
        await expect(index.search("(x", { regex: true })).rejects.toThrow(SyntaxError);
      });

      it("drop removes the index; init starts it empty", async () => {
        await index.upsert(items(["dropped text"]));
        await index.drop();
        await index.init();
        expect((await index.search("dropped")).hits).toEqual([]);
        expect((await index.search("d")).hits).toEqual([]);
      });

      it("getTexts returns stored texts of known ids only", async () => {
        await index.upsert([
          { id: 3, text: "three" },
          { id: 7, text: "seven" },
        ]);
        await index.delete([7]);
        expect(await index.getTexts([3, 7, 99])).toEqual(new Map([[3, "three"]]));
        const [row] = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${index.idTable}`);
        expect(Number(row?.n)).toBe(1);
      });

      it("drop from a default-store handle removes every table of either store", async () => {
        await index.upsert(items(["some text"]));
        await new NgramStore({ db, prefix: "t_" }).drop();
        const left = await db.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name LIKE 't\\_%' ESCAPE '\\'",
        );
        expect(left).toEqual([]);
      });
    });
  }
}

describe("NgramStore options", () => {
  it("rejects a prefix that is not a plain SQL identifier", async () => {
    const db = await newNodeSqliteDb();
    expect(() => new NgramStore({ db, prefix: "x; DROP TABLE y" })).toThrow(/prefix/);
    await db.close();
  });
});
