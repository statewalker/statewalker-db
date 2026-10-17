# db-sqlite-index `./ngram` (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an id-based n-gram (trigram) index in SQLite that answers literal and regex searches exactly. It is exposed as `@statewalker/db-sqlite-index/ngram`, with an FTS5-trigram store by default and a custom postings store as the alternative.

**Architecture:**
- **Pure core** (no `db-*` imports):
  - `fold` case-folds per code point;
  - `trigrams` extracts code-point grams;
  - `planQuery` turns a pattern into a regex plus a DNF of required literals (a port of hypgrep's `regex.js`, Russ Cox's method).
- **Over a `Db`:** `NgramStore` keeps the original text in `{p}texts` and finds candidates through one of two backends:
  - `fts5`: a contentless FTS5 `trigram case_sensitive 1` table over folded text;
  - `postings`: a `{p}grams(gram INTEGER, id) WITHOUT ROWID` table.
- **Verification:** the real regex runs on each candidate's original text.
- **Scan fallback:** a pattern with no usable trigram scans `{p}texts`.
- **Writes** run inside `inTransaction`. Every batch travels as one JSON parameter through `json_each(?)`.

**Tech Stack:** TypeScript (strict; the package tsconfig, shared with P2, turns `noUncheckedIndexedAccess` off for typed-array loops — the code below compiles either way), `@statewalker/db-api` `Db`, `@statewalker/db-sqlite` `inTransaction`, SQLite FTS5 trigram tokenizer, vitest 5, tsdown, biome, pnpm 10.16.1, changesets.

**Spec:** `~/workspace-statewalker/notes/2026/2026-10/2026-10-17/grill-sqlite-db-indexing.md`, sections D8, D10 (consumer contract), D12, D14 (n-gram), D15 P3.

**Depends on (P1, statewalker-db, same umbrella branch):**
- `@statewalker/db-sqlite`: `inTransaction<T>(db: Db, cb: (tx: Db) => Promise<T>): Promise<T>`.
- `@statewalker/db-sqlite-node`: `newNodeSqliteDb(options?: DbOptions): Promise<Db>`, on node:sqlite.
- `@statewalker/db-sqlite-do`: `newDoSqliteDb(storage): Db` (synchronous), and from the Node-only subpath `@statewalker/db-sqlite-do/fake` the test helper `newFakeDoStorage()`. The fake enforces the probed DO limits (≤ 100 bound parameters, BLOB/string ≤ 2 MB, no `BEGIN`/`PRAGMA`).

## Global Constraints

- **Package:** `@statewalker/db-sqlite-index`, directory `packages/db-sqlite-index`. This plan owns the subpath `./ngram`; P2 owns `./vector`. There is no `.` export.
- **Pure core:** `src/ngram/fold.ts`, `trigrams.ts`, `regex-literals.ts` and `plan-query.ts` import nothing from `@statewalker/db-*`.
- **DB API:** `@statewalker/db-api` stays unchanged. DML goes through `db.query(sql, params)`; `db.exec(sql)` is only for parameterless DDL. One statement per `exec` call.
- **Transactions:** every write runs inside `inTransaction`. The callback does no external I/O and is idempotent, because a DO may retry it.
- **Transactions are owned by the store:** `init`, `upsert`, `delete` and `drop` each run their own `inTransaction`. Callers (P5's provider) never call them from inside an `inTransaction` callback: the store holds the outer `Db`, so on Node/browser the inner call waits for the outer transaction forever.
- **Bound parameters:** never more than a handful. Id lists and row batches go as one JSON array through `json_each(?)`. Each JSON parameter stays ≤ 500,000 UTF-16 code units, which keeps it under DO's ~2 MB string limit even at 4 bytes per code point.
- **Forbidden SQL:** `PRAGMA`, `sqlite_version()`, `BEGIN` and `SAVEPOINT`. They are "not authorized" on DO.
- **Matches:** stay inside one stored text. Offsets are UTF-16 code units of the original text.
- **Defaults:** `caseSensitive` defaults to `true` (grep semantics); `limit` defaults to 100; `candidateBudget` defaults to 10,000; the pattern length cap is 1,000 characters.
- **Repo conventions:**
  - kebab-case file names;
  - tests next to the source as `*.test.ts`;
  - biome: 2 spaces, double quotes, trailing commas, line width 100.
- **No data in the repo:** fixtures are generated (`qwertyu0001…qwertyu1000`, identical to pg_trgm's `trgm.data`) or neutral invented text. No dataset files are vendored.
- **License:** MIT. The ported `regex.js` (hypgrep 0.5.3, MIT, Hyperparam) keeps its permission notice in the file header.

## Review Focus

1. **One upsert batch that repeats an id.** The last text must win, with no stale grams. A contentless FTS5 table silently accepts a second row with the same rowid, and the index is then corrupt. → Task 3: test "duplicate ids in one upsert keep the last text".
2. **A batch whose JSON exceeds one parameter.** Say 3,000 texts of 400 characters: on DO it fails with "string or blob too big" unless the batch is chunked. → Task 3: test "upserts a batch larger than one JSON parameter".
3. **Astral characters and patterns shorter than 3 code points.** For `😀a`, `東京` or `ab` the result must be exact: neither a false negative nor a split surrogate pair. Offsets must be UTF-16. → Task 3 and Task 4: unicode and short-pattern rows in the oracle suite.
4. **Case-insensitive search over letters with irregular case folding.** `ς`/`σ`/`Σ`, `ſ`, `K` (Kelvin), `ß`/`ẞ` and `İ`: the fold the index applies must never separate two characters that `/x/i` treats as equal. → Task 1: a property test over all BMP code points, plus the unicode oracle rows.
5. **A pattern that matches only the empty string** (`(abc)*$`, `^`, `""`) must return no hits and must not loop. → Task 3 oracle rows plus the empty-pattern test.

---

## File Structure

```
packages/db-sqlite-index/
  package.json               # created here or by P2; this plan adds the "./ngram" export
  tsconfig.json              # shared with P2: db-sqlite-node's, noUncheckedIndexedAccess off
  tsdown.config.ts           # entries: ngram (and P2's vector) → dist/ngram.mjs, dist/vector.mjs
  README.md                  # package README; this plan writes the n-gram sections
  src/ngram/
    index.ts                 # public exports of ./ngram
    fold.ts                  # fold(text): per-code-point case fold (pure)
    fold.test.ts
    trigrams.ts              # trigrams(text), gramsOf(folded), encodeGram(gram) (pure)
    trigrams.test.ts
    regex-literals.ts        # regexLiterals(regex): string[][] — port of hypgrep regex.js (pure)
    plan-query.ts            # planQuery(pattern, opts): QueryPlan (pure)
    plan-query.test.ts       # codesearch/hypgrep table + literal-mode cases
    json-chunks.ts           # chunkJson(rows): JSON parameters ≤ 500k code units
    fts5-backend.ts          # GramBackend over FTS5 trigram (contentless)
    postings-backend.ts      # GramBackend over {p}grams WITHOUT ROWID
    ngram-store.ts           # NgramStore: init/upsert/delete/search/drop, verifier, scan fallback
    ngram-store.test.ts      # lifecycle + index == brute-force scan, stores × drivers
.changeset/db-sqlite-index-ngram.md
```

Public exports of `@statewalker/db-sqlite-index/ngram`:
- `NgramStore`
- the types `NgramStoreOptions`, `NgramItem`, `NgramSearchOptions`, `NgramSearchResult`, `NgramHit`, `NgramMatch`, `QueryPlan`
- the pure functions `planQuery`, `trigrams`, `fold`
- the constant `MAX_PATTERN_LENGTH`

`regexLiterals`, `gramsOf`, `encodeGram`, `chunkJson` and the backends stay internal.

---

### Task 1: Package skeleton, `fold` and `trigrams`

**Files:**
- Create (or extend, if P2 already created it): `packages/db-sqlite-index/package.json`, `tsconfig.json`, `tsdown.config.ts`
- Create: `packages/db-sqlite-index/src/ngram/fold.ts`, `src/ngram/trigrams.ts`, `src/ngram/index.ts`
- Test: `packages/db-sqlite-index/src/ngram/fold.test.ts`, `src/ngram/trigrams.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `fold(text: string): string`
  - `trigrams(text: string): string[]`, the distinct trigrams of `fold(text)`
  - `gramsOf(folded: string): string[]` (internal)
  - `encodeGram(gram: string): number` (internal)

- [ ] **Step 1: Create or extend the package**

The skeleton is **identical** in P2 and P3 (P2 Task 1 Step 1 has the same text), so whichever plan lands first creates it and the second only adds its `tsdown` entry.
If `packages/db-sqlite-index/package.json` **already exists** (P2 landed first), change nothing in `package.json` or `tsconfig.json`; add `ngram: "src/ngram/index.ts"` to the `entry` object of `tsdown.config.ts`.

Otherwise create these files. The `tsdown` entry for this plan is `ngram: "src/ngram/index.ts"` (replace the `vector` line if `src/vector/index.ts` does not exist yet). The `bench` script and `tsx` belong to P2's bench; they are harmless before it lands.

`packages/db-sqlite-index/package.json`:

```json
{
  "name": "@statewalker/db-sqlite-index",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "description": "Id-based vector (IVF) and n-gram indexes stored in SQLite through @statewalker/db-api: Node, browser and Durable Objects.",
  "bugs": {
    "url": "https://github.com/statewalker/statewalker-db/issues"
  },
  "homepage": "https://github.com/statewalker/statewalker-db/tree/main/packages/db-sqlite-index#readme",
  "author": {
    "name": "Mikhail Kotelnikov",
    "email": "mikhail.kotelnikov@gmail.com"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/statewalker/statewalker-db.git",
    "directory": "packages/db-sqlite-index"
  },
  "exports": {
    "./vector": {
      "source": "./src/vector/index.ts",
      "types": "./dist/vector.d.mts",
      "import": "./dist/vector.mjs"
    },
    "./ngram": {
      "source": "./src/ngram/index.ts",
      "types": "./dist/ngram.d.mts",
      "import": "./dist/ngram.mjs"
    }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsdown",
    "prepack": "pnpm run build",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "bench": "tsx bench/vector-bench.ts 50000 384",
    "clean": "rimraf dist",
    "lint": "biome check --write .",
    "format": "biome format --write ."
  },
  "dependencies": {
    "@statewalker/db-api": "workspace:^",
    "@statewalker/db-sqlite": "workspace:^"
  },
  "devDependencies": {
    "@statewalker/db-sqlite-do": "workspace:^",
    "@statewalker/db-sqlite-node": "workspace:^",
    "@types/node": "catalog:",
    "rimraf": "catalog:",
    "tsdown": "catalog:",
    "tsx": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "sideEffects": false,
  "publishConfig": {
    "access": "public"
  }
}
```

`packages/db-sqlite-index/tsconfig.json` is a copy of `packages/db-sqlite-node/tsconfig.json` with one change: `noUncheckedIndexedAccess` is off. Every hot loop in this package indexes typed arrays within bounds it computed itself, so `| undefined` on each read would add only noise.

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    // Typed-array hot loops index within bounds computed by the code itself.
    "noUncheckedIndexedAccess": false,
    "resolvePackageJsonExports": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": true
  },
  "include": ["./src"],
  "exclude": ["node_modules", "dist"]
}
```

`packages/db-sqlite-index/tsdown.config.ts` (if P3 landed first, add only the `vector` line; P3 adds `ngram: "src/ngram/index.ts"` the same way):

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    vector: "src/vector/index.ts", // only if src/vector/index.ts exists
    ngram: "src/ngram/index.ts",
  },
  format: "esm",
  dts: true,
});
```

Run: `pnpm install` (from the `statewalker-db` root of the umbrella feature worktree)
Expected: the lockfile gains `packages/db-sqlite-index`, with no errors.

- [ ] **Step 2: Write the failing tests**

`src/ngram/fold.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fold } from "./fold.js";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

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
      const re = new RegExp(`^${escape(c)}$`, "i");
      for (const d of [c.toUpperCase(), c.toLowerCase()]) {
        if (d === c || d.length !== 1 || !re.test(d)) continue;
        if (fold(c) !== fold(d)) broken.push(`U+${cp.toString(16)} ${c}/${d}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("is a homomorphism over concatenation, so substrings stay substrings", () => {
    const a = "ΟΔΟΣ ſtraße";
    const b = "İK";
    expect(fold(a + b)).toBe(fold(a) + fold(b));
  });
});
```

`src/ngram/trigrams.test.ts`:

```ts
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
```

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm --filter @statewalker/db-sqlite-index test`
Expected: FAIL with "Failed to resolve import "./fold.js"".

- [ ] **Step 4: Implement**

`src/ngram/fold.ts`:

```ts
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
```

`src/ngram/trigrams.ts`:

```ts
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
```

`src/ngram/index.ts`:

```ts
export { fold } from "./fold.js";
export { trigrams } from "./trigrams.js";
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `pnpm --filter @statewalker/db-sqlite-index test`
Expected: PASS (6 tests).

If the BMP property test lists characters, `fold` is wrong for them. Fix `fold`, not the test.

- [ ] **Step 6: Typecheck, lint, build**

Run:
```bash
pnpm --filter @statewalker/db-sqlite-index typecheck
pnpm biome check --write --unsafe packages/db-sqlite-index
pnpm --filter @statewalker/db-sqlite-index build && ls packages/db-sqlite-index/dist/ngram.mjs
```
Expected:
- no type errors;
- biome reports no errors;
- `index.mjs` and `index.d.mts` are listed.

- [ ] **Step 7: Commit**

```bash
git add packages/db-sqlite-index pnpm-lock.yaml
git commit -m "feat(db-sqlite-index): ngram fold and trigram extraction"
```

---

### Task 2: Regex planner — `regexLiterals` port and `planQuery`

**Files:**
- Create: `packages/db-sqlite-index/src/ngram/regex-literals.ts`, `src/ngram/plan-query.ts`
- Modify: `packages/db-sqlite-index/src/ngram/index.ts`
- Test: `packages/db-sqlite-index/src/ngram/plan-query.test.ts`

**Interfaces:**
- Consumes: `fold(text)` from Task 1.
- Produces:
  - `regexLiterals(regex: RegExp): string[][]`, the DNF of mandatory literals, unfolded (internal);
  - `type QueryPlan = { regex: RegExp; branches: string[][] | null }`:
    - `regex` has the `g` flag, plus `i` when `caseSensitive === false`;
    - `branches` holds the **folded** literals of ≥ 3 code points per branch, or is `null` when any branch has none (a scan is needed);
  - `planQuery(pattern: string, opts?: { regex?: boolean; caseSensitive?: boolean }): QueryPlan`;
  - `MAX_PATTERN_LENGTH = 1000`.

- [ ] **Step 1: Write the failing table test**

The expected values come from running hypgrep 0.5.3's `extractRegexLiterals` on each pattern, then folding and dropping literals shorter than 3 code points. The cases follow codesearch's `index/regexp_test.go` and pg_trgm's regex list.

`src/ngram/plan-query.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_PATTERN_LENGTH, planQuery } from "./plan-query.js";

const REGEX_TABLE: Array<[string, string[][] | null]> = [
  ["abc", [["abc"]]],
  ["abc(def|ghi)", [["abcdef"], ["abcghi"]]],
  ["abc.*def", [["abc", "def"]]],
  ["abc.*(def|ghi)", [["abc", "def"], ["abc", "ghi"]]],
  ["a+hello", [["hello"]]],
  ["(abc)(def)", [["abcdef"]]],
  [
    "[ab][cd][ef]",
    [["ace"], ["acf"], ["ade"], ["adf"], ["bce"], ["bcf"], ["bde"], ["bdf"]],
  ],
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
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @statewalker/db-sqlite-index test -- plan-query`
Expected: FAIL with "Failed to resolve import "./plan-query.js"".

- [ ] **Step 3: Port `regex.js` to `src/ngram/regex-literals.ts`**

This is a port of `extractRegexLiterals` and its helpers from hypgrep 0.5.3 `src/regex.js`. The changes:
- the shape-layer functions are dropped;
- the `lower` parameter is removed, because `planQuery` folds the literals afterwards;
- the code is typed for strict TS.

Fetch the original for side-by-side review with `npm pack hypgrep@0.5.3` in a scratch directory.

```ts
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

function splitTopLevelAlternation(src: string, start: number, end: number): Array<[number, number]> {
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
      if (q.copies === 0 || chars === null || q.copies > 1 || cross.length * chars.length > MAX_DNF) {
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
function parseEscapedLiteral(src: string, start: number): { char: string; end: number } | undefined {
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
```

- [ ] **Step 4: Implement `src/ngram/plan-query.ts`**

```ts
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
```

Update `src/ngram/index.ts`:

```ts
export { fold } from "./fold.js";
export { MAX_PATTERN_LENGTH, planQuery, type QueryPlan } from "./plan-query.js";
export { trigrams } from "./trigrams.js";
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `pnpm --filter @statewalker/db-sqlite-index test`
Expected: PASS. All rows of `REGEX_TABLE` pass, as do the Task 1 tests.

If a row differs from hypgrep's output (`extractRegexLiterals` after fold and the ≥ 3 filter), the port is wrong. Fix the port, not the table.

- [ ] **Step 6: Typecheck and lint**

Run:
```bash
pnpm --filter @statewalker/db-sqlite-index typecheck
pnpm biome check --write --unsafe packages/db-sqlite-index
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db-sqlite-index
git commit -m "feat(db-sqlite-index): regex to trigram-literal planner for ngram search"
```

---

### Task 3: `NgramStore` with the FTS5 trigram store, verifier and scan fallback

**Files:**
- Create: `packages/db-sqlite-index/src/ngram/json-chunks.ts`, `src/ngram/fts5-backend.ts`, `src/ngram/ngram-store.ts`
- Modify: `packages/db-sqlite-index/src/ngram/index.ts`
- Create (or extend, if P2 created it): `packages/db-sqlite-index/README.md`
- Test: `packages/db-sqlite-index/src/ngram/ngram-store.test.ts`

**Interfaces:**
- Consumes:
  - `planQuery`, `fold`, `gramsOf` from Tasks 1–2;
  - `inTransaction` from `@statewalker/db-sqlite`;
  - `newNodeSqliteDb` from `@statewalker/db-sqlite-node`;
  - `newDoSqliteDb` from `@statewalker/db-sqlite-do`, `newFakeDoStorage` from `@statewalker/db-sqlite-do/fake`.
- Produces (public; P5's `indexer-sqlite` consumes these exact shapes):

  ```ts
  type NgramItem = { id: number; text: string };
  type NgramMatch = { start: number; end: number };
  type NgramHit = { id: number; matches: NgramMatch[] };
  type NgramSearchOptions = {
    regex?: boolean;
    caseSensitive?: boolean;
    limit?: number;
    candidateBudget?: number;
    filter?: (id: number) => boolean;
    signal?: AbortSignal;
  };
  type NgramSearchResult = { hits: NgramHit[]; truncated: boolean };
  type NgramStoreOptions = { db: Db; prefix: string; store?: "fts5" | "postings" };

  class NgramStore {
    constructor(opts: NgramStoreOptions);
    init(): Promise<void>;
    upsert(items: NgramItem[]): Promise<void>;
    delete(ids: number[]): Promise<void>;
    search(pattern: string, opts?: NgramSearchOptions): Promise<NgramSearchResult>;
    getTexts(ids: number[]): Promise<Map<number, string>>;
    readonly idTable: string;
    drop(): Promise<void>;
  }
  ```

  Added for P5 (`indexer-sqlite`): `getTexts` returns the stored original texts of the known ids (unknown ids are absent); `idTable` is `{prefix}texts`, whose `id INTEGER` column holds exactly the stored ids — a public contract P5 joins in SQL for size and enumeration; `drop()` removes the tables of **both** stores, so a caller that does not know the store type (P5's `drop(ctx)` gets no config) can drop any n-gram index with `new NgramStore({ db, prefix }).drop()`.

  The internal `GramBackend` type is also produced here; Task 4 implements it.

Semantics:
- **`search`**
  - Hits come in ascending id order; each hit holds every non-empty match.
  - `truncated` is `true` when the search stopped before checking every candidate: the `candidateBudget` cut, or `limit` was reached with candidates left.
  - `filter` runs on candidates before verification.
  - `signal` is checked before each verify batch.
- **`init`**
  - It must run once before the other methods; otherwise they fail with SQLite's "no such table".
  - It rejects a prefix created with the other store.
- **`upsert`**
  - Overwrites by id.
  - Within one call, the last item per id wins.

- [ ] **Step 1: Write the failing store tests**

`src/ngram/ngram-store.test.ts`:

```ts
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
const TRGM = items(Array.from({ length: 1000 }, (_, i) => `qwertyu${String(i + 1).padStart(4, "0")}`));
/** Same rows as pg_trgm's test2 table. */
const TEST2 = items([
  "abcdef", "quark", "  z foo bar", "/123/-45/", "line 1",
  "%line 2", "line 3%", "%line 4%", "%li%ne 5%", "li_e 6",
]);
const UNICODE = items([
  "Straße und STRASSE", "ſtraße", "ΟΔΟΣ οδός ΟΔΟΣ", "😀abc😀 x😀y", "東京タワー と 東京駅",
  "İstanbul istanbul", "Kelvin K and k", "ẞ ß ss",
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
        expect((await index.search("gamma")).hits.map((h) => h.id)).toEqual([1]);
      });

      it("duplicate ids in one upsert keep the last text", async () => {
        await index.upsert([
          { id: 1, text: "first version" },
          { id: 1, text: "second version" },
        ]);
        expect((await index.search("first")).hits).toEqual([]);
        expect((await index.search("version")).hits.map((h) => h.id)).toEqual([1]);
        await index.delete([1]);
        expect((await index.search("version")).hits).toEqual([]);
      });

      it("delete removes items from index and scan", async () => {
        await index.upsert(items(["one two", "two three"]));
        await index.delete([1]);
        expect((await index.search("two")).hits.map((h) => h.id)).toEqual([2]);
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
          scan(TRGM, "qwertyu09").map((h) => h.id).filter((id) => id % 2 === 0),
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
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @statewalker/db-sqlite-index test -- ngram-store`
Expected: FAIL. `NgramStore` is not exported from `./index.js`.

- [ ] **Step 3: Implement `src/ngram/json-chunks.ts`**

```ts
/**
 * Serialises rows into JSON array parameters for `json_each(?)`, each at most
 * `maxChars` UTF-16 code units. 500k code units stay under a Durable Object's
 * ~2 MB string limit even at 4 bytes per code point; a single row larger than
 * that still fails there with "string or blob too big".
 */
export function chunkJson(rows: unknown[], maxChars = 500_000): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 2;
  for (const row of rows) {
    const json = JSON.stringify(row);
    if (current.length > 0 && size + json.length + 1 > maxChars) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      size = 2;
    }
    current.push(json);
    size += json.length + 1;
  }
  if (current.length > 0) chunks.push(`[${current.join(",")}]`);
  return chunks;
}
```

- [ ] **Step 4: Implement `src/ngram/fts5-backend.ts`**

```ts
import type { Db } from "@statewalker/db-api";
import { fold } from "./fold.js";
import { chunkJson } from "./json-chunks.js";

export type NgramItem = { id: number; text: string };

/** How one store finds candidate ids; texts and verification live in NgramStore. */
export type GramBackend = {
  create(tx: Db): Promise<void>;
  add(tx: Db, items: NgramItem[]): Promise<void>;
  /** `items` hold the texts as currently stored, so their grams can be removed exactly. */
  remove(tx: Db, items: NgramItem[]): Promise<void>;
  /** Ids whose text contains every literal of at least one branch; ascending, at most `max`. */
  candidates(db: Db, branches: string[][], max: number): Promise<number[]>;
};

const ROW = "json_extract(value, '$[0]'), json_extract(value, '$[1]')";

/**
 * FTS5 trigram over folded text. Contentless (`content=''`), because NgramStore
 * already keeps the text; a contentless row is deleted by replaying its exact
 * indexed value through the 'delete' command, which is why `remove` needs the
 * stored texts. `case_sensitive 1`: folding is done by `fold`, the same function
 * that folds query literals, so the index and the planner can never disagree.
 */
export function newFts5Backend(prefix: string): GramBackend {
  const table = `${prefix}ng`;
  const write = async (tx: Db, items: NgramItem[], command: "insert" | "delete") => {
    const sql =
      command === "insert"
        ? `INSERT INTO ${table}(rowid, text) SELECT ${ROW} FROM json_each(?)`
        : `INSERT INTO ${table}(${table}, rowid, text) SELECT 'delete', ${ROW} FROM json_each(?)`;
    for (const chunk of chunkJson(items.map((item) => [item.id, fold(item.text)]))) {
      await tx.query(sql, [chunk]);
    }
  };
  return {
    create: (tx) =>
      tx.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(text, content='', tokenize='trigram case_sensitive 1')`,
      ),
    add: (tx, items) => write(tx, items, "insert"),
    remove: (tx, items) => write(tx, items, "delete"),
    async candidates(db, branches, max) {
      // A quoted string is a phrase of consecutive trigrams, i.e. an exact substring.
      const quote = (literal: string) => `"${literal.replaceAll('"', '""')}"`;
      const match = branches.map((branch) => `(${branch.map(quote).join(" AND ")})`).join(" OR ");
      const rows = await db.query<{ id: number }>(
        `SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid LIMIT ?`,
        [match, max],
      );
      return rows.map((row) => Number(row.id));
    },
  };
}
```

- [ ] **Step 5: Implement `src/ngram/ngram-store.ts`**

```ts
import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";
import { type GramBackend, type NgramItem, newFts5Backend } from "./fts5-backend.js";
import { chunkJson } from "./json-chunks.js";
import { planQuery } from "./plan-query.js";

export type { NgramItem };
export type NgramMatch = { start: number; end: number };
export type NgramHit = { id: number; matches: NgramMatch[] };
export type NgramSearchOptions = {
  /** Treat `pattern` as a JS regex source; otherwise it is literal text. */
  regex?: boolean;
  /** Default true (grep semantics). */
  caseSensitive?: boolean;
  /** Maximum hits. Default 100. */
  limit?: number;
  /** Maximum candidates verified. Default 10,000. */
  candidateBudget?: number;
  /** Keep only ids for which this returns true (applied before verification). */
  filter?: (id: number) => boolean;
  signal?: AbortSignal;
};
export type NgramSearchResult = {
  /** Ascending id order; every non-empty match, offsets in UTF-16 code units. */
  hits: NgramHit[];
  /** True when the search stopped before checking every candidate (budget or limit). */
  truncated: boolean;
};
export type NgramStoreOptions = { db: Db; prefix: string; store?: "fts5" | "postings" };

const VERIFY_BATCH = 256;

export class NgramStore {
  /** `{prefix}texts`: its `id` column holds exactly the stored ids. Callers may join it in SQL. */
  readonly idTable: string;
  readonly #db: Db;
  readonly #prefix: string;
  readonly #store: "fts5" | "postings";
  readonly #backend: GramBackend;

  constructor({ db, prefix, store = "fts5" }: NgramStoreOptions) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
      throw new Error(`ngram: prefix "${prefix}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
    }
    if (store !== "fts5") throw new Error(`ngram: unknown store "${store}"`);
    this.#db = db;
    this.#prefix = prefix;
    this.idTable = `${prefix}texts`;
    this.#store = store;
    this.#backend = newFts5Backend(prefix);
  }

  async init(): Promise<void> {
    const p = this.#prefix;
    await inTransaction(this.#db, async (tx) => {
      await tx.exec(`CREATE TABLE IF NOT EXISTS ${p}meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const [row] = await tx.query<{ value: string }>(
        `SELECT value FROM ${p}meta WHERE key = 'store'`,
      );
      if (row && row.value !== this.#store) {
        throw new Error(
          `ngram: index "${p}" was created with store "${row.value}", opened with "${this.#store}"`,
        );
      }
      if (!row) await tx.query(`INSERT INTO ${p}meta(key, value) VALUES ('store', ?)`, [this.#store]);
      await tx.exec(`CREATE TABLE IF NOT EXISTS ${p}texts(id INTEGER PRIMARY KEY, text TEXT NOT NULL)`);
      await this.#backend.create(tx);
    });
  }

  async upsert(items: NgramItem[]): Promise<void> {
    // The last text per id wins; a repeated id would leave stale grams behind.
    const latest = [...new Map(items.map((item) => [item.id, item])).values()];
    if (latest.length === 0) return;
    await inTransaction(this.#db, async (tx) => {
      await this.#backend.remove(tx, await this.#load(tx, latest.map((item) => item.id)));
      for (const chunk of chunkJson(latest.map((item) => [item.id, item.text]))) {
        await tx.query(
          `INSERT OR REPLACE INTO ${this.#prefix}texts(id, text) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`,
          [chunk],
        );
      }
      await this.#backend.add(tx, latest);
    });
  }

  async delete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await inTransaction(this.#db, async (tx) => {
      await this.#backend.remove(tx, await this.#load(tx, ids));
      for (const chunk of chunkJson(ids)) {
        await tx.query(`DELETE FROM ${this.#prefix}texts WHERE id IN (SELECT value FROM json_each(?))`, [
          chunk,
        ]);
      }
    });
  }

  async search(pattern: string, opts: NgramSearchOptions = {}): Promise<NgramSearchResult> {
    const { limit = 100, candidateBudget = 10_000, filter, signal } = opts;
    const plan = planQuery(pattern, { regex: opts.regex, caseSensitive: opts.caseSensitive ?? true });
    signal?.throwIfAborted();
    const found =
      plan.branches === null
        ? (
            await this.#db.query<{ id: number }>(
              `SELECT id FROM ${this.#prefix}texts ORDER BY id LIMIT ?`,
              [candidateBudget + 1],
            )
          ).map((row) => Number(row.id))
        : await this.#backend.candidates(this.#db, plan.branches, candidateBudget + 1);
    let truncated = found.length > candidateBudget;
    const ids = found.slice(0, candidateBudget).filter((id) => !filter || filter(id));

    const hits: NgramHit[] = [];
    let last: number | undefined;
    verify: for (let i = 0; i < ids.length; i += VERIFY_BATCH) {
      signal?.throwIfAborted();
      for (const { id, text } of await this.#load(this.#db, ids.slice(i, i + VERIFY_BATCH))) {
        last = id;
        const matches: NgramMatch[] = [];
        for (const m of text.matchAll(plan.regex)) {
          if (m[0].length > 0) matches.push({ start: m.index, end: m.index + m[0].length });
        }
        if (matches.length === 0) continue;
        hits.push({ id, matches });
        if (hits.length >= limit) break verify;
      }
    }
    if (hits.length >= limit && last !== ids.at(-1)) truncated = true;
    return { hits, truncated };
  }

  /** The stored original texts of `ids`; unknown ids are absent. */
  async getTexts(ids: number[]): Promise<Map<number, string>> {
    const items = await this.#load(this.#db, ids);
    return new Map(items.map((item) => [item.id, item.text]));
  }

  /** Drops the tables of both stores, so it works without knowing which one created the prefix. */
  async drop(): Promise<void> {
    const p = this.#prefix;
    await inTransaction(this.#db, async (tx) => {
      for (const t of ["ng", "grams", "texts", "meta"]) await tx.exec(`DROP TABLE IF EXISTS ${p}${t}`);
    });
  }

  /** Stored texts for `ids`, ascending by id; missing ids are skipped. */
  async #load(db: Db, ids: number[]): Promise<NgramItem[]> {
    const out: NgramItem[] = [];
    for (const chunk of chunkJson([...ids].sort((a, b) => a - b))) {
      const rows = await db.query<{ id: number; text: string }>(
        `SELECT id, text FROM ${this.#prefix}texts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        [chunk],
      );
      for (const row of rows) out.push({ id: Number(row.id), text: String(row.text) });
    }
    return out;
  }
}
```

Update `src/ngram/index.ts`:

```ts
export { fold } from "./fold.js";
export {
  type NgramHit,
  type NgramItem,
  type NgramMatch,
  type NgramSearchOptions,
  type NgramSearchResult,
  NgramStore,
  type NgramStoreOptions,
} from "./ngram-store.js";
export { MAX_PATTERN_LENGTH, planQuery, type QueryPlan } from "./plan-query.js";
export { trigrams } from "./trigrams.js";
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `pnpm --filter @statewalker/db-sqlite-index test`
Expected: PASS on both drivers.

What a failure means:
- **An oracle row fails with missing hits:** the planner or the fold produced a literal that isn't in the text, which is a false negative. Fix `fold`, `planQuery` or the port, never the oracle.
- **Only the fake-DO driver fails:** compare against P1's DO driver contract (BLOB normalisation, `exec` semantics) before changing this code.

- [ ] **Step 7: Write the package README's n-gram sections**

If `README.md` doesn't exist, create it with the header below and then the n-gram sections. If P2 created it, add only the n-gram sections after its vector sections, and add `./ngram` to its "What it is" paragraph.

```markdown
# @statewalker/db-sqlite-index

## What it is

Id-based indexes stored in SQLite through `Db` from `@statewalker/db-api`, running
unchanged on node:sqlite, sqlite-wasm and Durable Object storage. `./ngram` finds
every stored text that contains a literal or matches a JavaScript regex, using a
trigram index to pick candidates and the real regex to confirm them.

## Why it exists

Full-text search matches words; it cannot find `idx_le`, `v2.3.1`, a fragment of
an identifier, or a regex. Scanning every text answers those questions but costs a
read of the whole store per query. A trigram index answers them by reading only
texts that contain all the pattern's required three-character pieces, and stays
exact because each candidate is checked with the regex itself.

## How to use (`./ngram`)

```ts
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { NgramStore } from "@statewalker/db-sqlite-index/ngram";

const db = await newNodeSqliteDb({ path: "index.db" });
const grams = new NgramStore({ db, prefix: "code_" }); // store: "fts5" (default) | "postings"
await grams.init();
await grams.upsert([{ id: 1, text: "const idx_left = 1;" }]);

const { hits, truncated } = await grams.search("idx_le");
// hits: [{ id: 1, matches: [{ start: 6, end: 12 }] }], truncated: false
await grams.search("idx_(left|right)", { regex: true, caseSensitive: false, limit: 20 });
```

Ids are integers chosen by the caller. Hits come in ascending id order with every
non-empty match; offsets are UTF-16 code units of the stored text.

## How a search stays exact

1. `planQuery` turns the pattern into a regex and a list of branches, each a set of
   literals that every match must contain (`abc(def|ghi)` → `abcdef` or `abcghi`).
2. Literals shorter than three code points cannot be looked up; a branch with none
   left makes the search scan every stored text instead.
3. The store returns ids whose text holds all literals of some branch.
4. The regex runs on each candidate's original text; only real matches are returned.

Text and literals are case-folded the same way (`fold`) before indexing, so a
case-insensitive regex never misses a text because of a case form (`Σ σ ς`, `ſ`).

## Two stores, one behaviour

- `fts5` (default): an SQLite FTS5 table with the `trigram` tokenizer. Nothing to
  maintain; uses SQLite's own posting lists.
- `postings`: one `(gram, id)` row per distinct trigram in a `WITHOUT ROWID` table.
  For SQLite builds without FTS5, and as an independently implemented check.

The store is recorded at `init`; opening the same prefix with the other store fails
with `ngram: index "<prefix>" was created with store "fts5", opened with "postings"`.

## What will surprise you

- `search` stops at `limit` hits (default 100) and verifies at most
  `candidateBudget` candidates (default 10,000); either cut sets `truncated: true`.
  A pattern with no three-character literal (`\d+`, `ab`) scans, and the budget
  then counts scanned texts.
- A pattern that matches only the empty string (`^`, `(abc)*$`) finds nothing.
- Patterns longer than 1,000 characters fail with
  `ngram: pattern is N characters, the limit is 1000`. A regex with catastrophic
  backtracking still runs to completion; the cap does not prevent that.
- An invalid regex fails with the engine's `SyntaxError`.
- Methods other than `init` fail with SQLite's `no such table` until `init` ran.
- On Durable Objects a single text above about 1.5 MB fails with
  `string or blob too big`; batches are split automatically, single texts are not.

## Internals

- Tables per prefix `p`: `{p}meta`, `{p}texts(id, text)`, and `{p}ng` (fts5,
  contentless, `tokenize='trigram case_sensitive 1'`) or `{p}grams(gram, id)`.
- The FTS5 table is contentless: the text is kept once, in `{p}texts`, and a row is
  deleted by replaying its indexed value — so writes read the previous text first.
- Trigrams are three code points; a surrogate pair is never split. In `postings` a
  gram of three BMP code points is one exact 48-bit integer; grams with an astral
  code point are hashed above 2^48, where a collision only adds a candidate.
- Every write runs inside `inTransaction` from `@statewalker/db-sqlite`. Batches
  are sent as JSON through `json_each(?)` in parts of at most 500,000 code units,
  because a Durable Object rejects more than ~100 bound parameters and values
  above ~2 MB.
- The regex-to-literals planner is ported from hypgrep's `regex.js` (MIT).
- Dependencies: `@statewalker/db-api`, `@statewalker/db-sqlite`. The planner, fold
  and trigram code import neither.

## License

MIT
```

- [ ] **Step 8: Typecheck and lint**

Run:
```bash
pnpm --filter @statewalker/db-sqlite-index typecheck
pnpm biome check --write --unsafe packages/db-sqlite-index
```
Expected: no errors.

The `verify:` label on a loop is allowed by biome's `noConfusingLabels`. If biome still flags it, replace it with a `done` boolean checked by both loops.

- [ ] **Step 9: Commit**

```bash
git add packages/db-sqlite-index
git commit -m "feat(db-sqlite-index): NgramStore over FTS5 trigram with regex verification"
```

---

### Task 4: The `postings` store, store-mismatch check, changeset

**Files:**
- Create: `packages/db-sqlite-index/src/ngram/postings-backend.ts`
- Modify: `packages/db-sqlite-index/src/ngram/ngram-store.ts` (constructor backend selection)
- Modify: `packages/db-sqlite-index/src/ngram/ngram-store.test.ts` (add `"postings"` to `STORES`, add the mismatch test)
- Create: `.changeset/db-sqlite-index-ngram.md`

**Interfaces:**
- Consumes:
  - `GramBackend` and `NgramItem` from `fts5-backend.ts` (Task 3);
  - `gramsOf`, `encodeGram`, `trigrams` (Task 1);
  - `chunkJson` (Task 3).
- Produces: `newPostingsBackend(prefix: string): GramBackend`. `NgramStore` accepts `store: "postings"`.

- [ ] **Step 1: Extend the tests so they fail**

In `src/ngram/ngram-store.test.ts`, change the store list:

```ts
const STORES = ["fts5", "postings"] as const;
```

Append:

```ts
describe("NgramStore store choice", () => {
  it("rejects opening a prefix with the other store", async () => {
    const db = await newNodeSqliteDb();
    await new NgramStore({ db, prefix: "m_", store: "fts5" }).init();
    await expect(new NgramStore({ db, prefix: "m_", store: "postings" }).init()).rejects.toThrow(
      'ngram: index "m_" was created with store "fts5", opened with "postings"',
    );
    await db.close();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @statewalker/db-sqlite-index test -- ngram-store`
Expected: every `postings` case fails with `ngram: unknown store "postings"`.

- [ ] **Step 3: Implement `src/ngram/postings-backend.ts`**

```ts
import type { Db } from "@statewalker/db-api";
import type { GramBackend, NgramItem } from "./fts5-backend.js";
import { chunkJson } from "./json-chunks.js";
import { encodeGram, gramsOf, trigrams } from "./trigrams.js";

const PAIR = "json_extract(value, '$[0]'), json_extract(value, '$[1]')";

/**
 * One row per (gram, id) in a WITHOUT ROWID table: the primary key is the
 * posting list, clustered by gram. A text is a candidate for a branch when it
 * holds every distinct gram of the branch's literals.
 */
export function newPostingsBackend(prefix: string): GramBackend {
  const table = `${prefix}grams`;
  const pairs = (items: NgramItem[]) =>
    chunkJson(items.flatMap((item) => trigrams(item.text).map((gram) => [encodeGram(gram), item.id])));
  return {
    create: (tx) =>
      tx.exec(
        `CREATE TABLE IF NOT EXISTS ${table}(gram INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (gram, id)) WITHOUT ROWID`,
      ),
    async add(tx, items) {
      for (const chunk of pairs(items)) {
        await tx.query(`INSERT OR IGNORE INTO ${table}(gram, id) SELECT ${PAIR} FROM json_each(?)`, [
          chunk,
        ]);
      }
    },
    async remove(tx, items) {
      for (const chunk of pairs(items)) {
        await tx.query(
          `DELETE FROM ${table} WHERE (gram, id) IN (SELECT ${PAIR} FROM json_each(?))`,
          [chunk],
        );
      }
    },
    async candidates(db, branches, max) {
      const ids = new Set<number>();
      for (const branch of branches) {
        // Literals are already folded: split them without folding again.
        const grams = [...new Set(branch.flatMap((literal) => gramsOf(literal).map(encodeGram)))];
        const rows = await db.query<{ id: number }>(
          `SELECT id FROM ${table} WHERE gram IN (SELECT value FROM json_each(?)) GROUP BY id HAVING count(*) = ? ORDER BY id LIMIT ?`,
          [JSON.stringify(grams), grams.length, max],
        );
        for (const row of rows) ids.add(Number(row.id));
      }
      return [...ids].sort((a, b) => a - b).slice(0, max);
    },
  };
}
```

- [ ] **Step 4: Select the backend in `NgramStore`**

In `src/ngram/ngram-store.ts`, add the import:

```ts
import { newPostingsBackend } from "./postings-backend.js";
```

Then replace the two lines

```ts
    if (store !== "fts5") throw new Error(`ngram: unknown store "${store}"`);
```

and

```ts
    this.#backend = newFts5Backend(prefix);
```

with:

```ts
    if (store !== "fts5" && store !== "postings") throw new Error(`ngram: unknown store "${store}"`);
```

and

```ts
    this.#backend = store === "fts5" ? newFts5Backend(prefix) : newPostingsBackend(prefix);
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `pnpm --filter @statewalker/db-sqlite-index test`
Expected: PASS. Every oracle row and lifecycle case now runs for 2 stores × 2 drivers, plus the mismatch test.

- [ ] **Step 6: Add the changeset**

`.changeset/db-sqlite-index-ngram.md`:

```markdown
---
"@statewalker/db-sqlite-index": minor
---

Add `./ngram`: `NgramStore`, an id-based trigram index over SQLite (`fts5` or `postings` store) that answers literal and regex searches exactly, plus the pure `planQuery`, `trigrams` and `fold` helpers.
```

- [ ] **Step 7: Full package checks**

Run:
```bash
pnpm --filter @statewalker/db-sqlite-index test
pnpm --filter @statewalker/db-sqlite-index typecheck
pnpm biome check --write --unsafe packages/db-sqlite-index .changeset
pnpm --filter @statewalker/db-sqlite-index build
```
Expected: all pass, and `dist/ngram.mjs` exists.

- [ ] **Step 8: Commit**

```bash
git add packages/db-sqlite-index .changeset/db-sqlite-index-ngram.md
git commit -m "feat(db-sqlite-index): postings store for ngram index"
```

---

### Task 5: N-gram smoke scenario on a real celld (`test:do`)

**Files:**
- Create: `packages/db-sqlite-index/src/ngram/do-smoke.ts`
- Modify: `packages/db-sqlite-do/test-do/scenarios.ts` (P1 Task 4)

**Interfaces:**
- Consumes: `NgramStore` (Tasks 3–4); P1's `SCENARIOS` list of `{ name: string; run(db: Db): Promise<void> }` in `test-do/scenarios.ts`.
- Produces: `ngramDoScenarios` (not exported from the package; imported by relative path only).

Only plain FTS5 trigram was probed on celld. This checks what the store adds on the real platform: a contentless table with `case_sensitive 1`, the `'delete'` command, and `CREATE`/`DROP VIRTUAL TABLE` inside `storage.transaction`.

- [ ] **Step 1: Write the scenario**

`packages/db-sqlite-index/src/ngram/do-smoke.ts`:

```ts
import type { Db } from "@statewalker/db-api";
import { NgramStore } from "./ngram-store.js";

const check = (ok: boolean, message: string) => {
  if (!ok) throw new Error(`ngram smoke: ${message}`);
};

/** Run inside a real Durable Object by db-sqlite-do's `pnpm test:do`. */
export const ngramDoScenarios = [
  {
    name: "ngram: contentless fts5 trigram, delete command, virtual table DDL in a transaction",
    async run(db: Db) {
      const store = new NgramStore({ db, prefix: "smoke_" });
      await store.init(); // CREATE VIRTUAL TABLE … content='' … case_sensitive 1, inside inTransaction
      await store.upsert([
        { id: 1, text: "Hello World" },
        { id: 2, text: "hello there" },
      ]);
      const hits = (await store.search("hello", { caseSensitive: false })).hits.map((h) => h.id);
      check(hits.join() === "1,2", `case-insensitive hits ${hits.join()}`);
      await store.upsert([{ id: 1, text: "goodbye" }]); // 'delete' command replays the old text
      const after = (await store.search("World")).hits.map((h) => h.id);
      check(after.length === 0, `stale grams after overwrite: ${after.join()}`);
      await store.drop(); // DROP of the virtual table inside inTransaction
      const [row] = await db.query<{ n: number }>(
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'smoke%'",
      );
      check(Number(row?.n) === 0, `tables left after drop: ${row?.n}`);
    },
  },
];
```

- [ ] **Step 2: Register it**

In `packages/db-sqlite-do/test-do/scenarios.ts`, add the import and spread it into `SCENARIOS` (keep any other spread already there, e.g. P2's `vectorDoScenarios`):

```ts
import { ngramDoScenarios } from "../../db-sqlite-index/src/ngram/do-smoke.js";

export const SCENARIOS = [...sqliteTransactionScenarios, ...ngramDoScenarios];
```

- [ ] **Step 3: Run it on celld**

Run: `pnpm test:do`
Expected: the new case passes with the others. A `not authorized` on `CREATE VIRTUAL TABLE` or on the `'delete'` insert means celld does not allow it inside `storage.transaction`; stop and report it (it changes D12's default store), do not work around it in the scenario.

- [ ] **Step 4: Commit**

```bash
pnpm biome check --write --unsafe packages/db-sqlite-index/src/ngram/do-smoke.ts packages/db-sqlite-do/test-do/scenarios.ts
git add packages/db-sqlite-index/src/ngram/do-smoke.ts packages/db-sqlite-do/test-do/scenarios.ts
git commit -m "test(db-sqlite-index): n-gram smoke scenario on a real celld DO"
```

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
|---|---|
| D8: package `db-sqlite-index`, subpath `./ngram`, pure core without `db-*` imports | 1, Global Constraints |
| D12: planner (regex.js port) with the codesearch table | 2 |
| D12: verifier with pattern length cap, candidate budget, `truncated` | 2 (cap), 3 (budget, `truncated`) |
| D12: scan fallback | 3 |
| D12: `fts5` store (`{p}ng`, trigram, `rowid = id`, DNF → MATCH) | 3 |
| D12: `postings` store (`{p}grams` + `{p}texts`, integer grams, `GROUP BY HAVING count = n`) | 4 |
| D12: oracle index == scan, pg_trgm `trgm.data` rows and FTS5 short patterns | 3–4 (`TRGM` is generated, byte-identical to `trgm.data`) |
| D14: n-gram suites over node:sqlite and fake DO storage, both stores | 3–4 |
| D2: writes in `inTransaction`, `json_each` id lists | 3 |
| D14: DO tested both ways | fake DO in every suite (3–4); real celld smoke (5) |
| P5 needs: `getTexts`, `idTable`, `drop()` of either store | 3 |

The real `celld` check is Task 5, registered in P1's `test:do` harness. Shape, 5-gram and CJK layers, dense-gram skipping, packed segments and ranking are deferred by the spec.

**2. Placeholders:** none. Every code step has full code. The only "if it exists" branches are about whether P2's package files exist, and both cases are spelled out.

**3. Type consistency**
- `NgramItem`, `GramBackend` (`create`/`add`/`remove`/`candidates`), `planQuery → { regex, branches }`, `chunkJson(rows, maxChars)` and `encodeGram`/`gramsOf`/`trigrams` are used with the same names and signatures in every task.
- The public API matches the contract handed to P5.

**4. Review Focus:** each of the five lines has its test in the named task: duplicate ids (3), large batch (3), astral and short patterns (3/4 oracle plus the offsets test), the fold property (1), empty-only matches (3 oracle `(abc)*$`, `^`, `""`).
