# db-sqlite-index/vector Implementation Plan (P2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@statewalker/db-sqlite-index/vector`. It ports `vector-index` 0.1.0 onto `Db` (`@statewalker/db-api`), so one IVF vector index runs on Node (node:sqlite), in the browser (sqlite-wasm) and in Durable Objects (CellD).

**Architecture:**
- **What stays from 0.1.0:** the LSM design. That is a SQLite tail mirrored in memory, immutable IVF segments, generation liveness through `{p}ids(id, gen)`, a RaBitQ-style 1-bit filter, int8 re-rank and stored float32. **Spec amendment (D11):** float32 is always stored, no longer optional, because exact re-rank, lossless `merge` and the new `getVectors` (needed by P5's `getDocumentsBlocks`) all read it.
- **What changes:** segments are no longer files read by range. They are SQL rows:
  - one row per list centroid;
  - a list's searchable block and its float block, split into parts of at most 1 MiB.
- **How segments get written:** in the same `inTransaction` that moves ids out of the tail, so there are no orphan files and no `commitOrDrop`.
- **What is I/O-free:** the core (math, k-means, segment codec, types). Only `sql-segment-store.ts` and `vector-index.ts` know about `Db`.

**Tech Stack:** TypeScript (catalog `typescript`), tsdown, vitest, biome, pnpm 10 workspace. `@statewalker/db-api`, `@statewalker/db-sqlite` (`inTransaction`), node:sqlite and fake DO storage for tests.

**Spec:** `~/workspace-statewalker/notes/2026/2026-10/2026-10-17/grill-sqlite-db-indexing.md`: D8, D11, D14 (vector), D15 (P2). The source being ported is `vector-index` 0.1.0 in `~/workspace-statewalker/notes/drive/2026-09-17.Vector-Index/code-vector-index.tar.gz`. Its design is described in notes 05–07 of the same folder.

**Depends on (must be merged first):** the P1 plan (statewalker-db), which provides:
- `inTransaction` from `@statewalker/db-sqlite`;
- `newNodeSqliteDb` on node:sqlite;
- `newDoSqliteDb` from `@statewalker/db-sqlite-do`;
- `newFakeDoStorage` from `@statewalker/db-sqlite-do/fake` (Node-only subpath; it enforces the probed DO limits: ≤ 100 bound parameters, BLOB ≤ 2 MB, no `BEGIN`/`PRAGMA`).

P3 (`./ngram`) runs in parallel in the same package. Work happens in `workspaces/statewalker-db` of the umbrella feature worktree `umbrella-sqlite-indexing__sqlite-db`, branch `feat/sqlite-db` (D16, see P1 "Where to run").

## Global Constraints

**Database access:**
- One async `Db` API: `query<T>(sql, params?) → Promise<T[]>`, `exec(sql)`, `close()`. `@statewalker/db-api` is not changed.
- All writes run inside `inTransaction(db, async (tx) => …)` from `@statewalker/db-sqlite`.
  - The callback only runs SQL and is idempotent: Durable Objects may retry it.
  - In-memory state changes only after the transaction resolves.

**Durable Object SQLite limits:**
- No bound value larger than `PART_BYTES = 1024 * 1024`. DO SQLite rejects a 2.5 MB BLOB with "string or blob too big"; 1.9 MB was measured as fine.
- No statement with more than 4 bound parameters. Id lists go through `json_each(?)` with one JSON parameter. DO rejects 200 parameters with "too many SQL variables".
- No `PRAGMA`, no `sqlite_version()`, no `BEGIN`/`SAVEPOINT` in package code. DO answers these with "not authorized".
- BLOB columns arrive as `Uint8Array`, normalised by the P1 drivers.

**Core and package boundaries:**
- Core modules `src/vector/{math,kmeans,segment,types}.ts` import nothing from `@statewalker/db-*`.
- The package depends only on `@statewalker/db-api` and `@statewalker/db-sqlite`. No link to statewalker-search.

**Algorithm parameters:**
- A segment is flat (one list) below `MIN_TRAIN = 2048` vectors.
- Auto-compact runs at a tail of `4096` vectors, sized for celld's 15 s operation deadline.
- Metrics: `"cosine" | "dot" | "l2"`.

**0.1.0 public API kept:**
- `init`, `refresh`, `stats`, `upsert`, `delete`, `search(q, { k, nprobe, oversample, exact, filter, signal })`, `compact`, `merge`, `optimize`.
- Only the constructor options change, to `{ db, prefix, dims, metric?, nlist?, cacheBytes?, autoCompactAt? }` (0.1.0's `storeFloats` is gone: floats are always stored).
- **Additions for P5 (statewalker-search `indexer-sqlite`):** `getVectors(ids)`, the read-only `idTable` name, and the standalone `dropVectorIndex(db, prefix)`.

**Transactions are owned by the engine:**
- Every write — `upsert`, `delete`, `compact`, `merge`, `optimize`, `dropVectorIndex` — runs its own `inTransaction`.
- Callers never call them from inside an `inTransaction` callback: the engine holds the outer `Db`, so the inner `inTransaction` waits for the outer one forever (Node/browser mutex). P5's providers and kernel call them outside any transaction.

**Conventions and per-task checks:**
- kebab-case file names; tests colocated as `src/**/*.test.ts` (vitest); biome formatting (2 spaces, double quotes, width 100).
- After each task:
  1. `pnpm --filter @statewalker/db-sqlite-index test`
  2. `pnpm --filter @statewalker/db-sqlite-index typecheck`
  3. `pnpm biome check --write --unsafe packages/db-sqlite-index`
  4. commit

## Review Focus

1. **A list block larger than one SQLite value** (high dims, or a big flat segment) is split into ≤ 1 MiB parts and re-joined. Search results stay correct. Test: Task 2, "splits list blocks into parts".
2. **A search running while `merge` retires the segments it reads** still returns correct hits. The retired rows go away at the next reap or on reopen (sweep). Test: Task 2, "search during merge".
3. **More ids in one call than DO's bound-parameter limit**, as in `delete` of 150 ids, works because ids travel as one `json_each` parameter. Test: Task 2, "deletes many ids in one call".
   - The fake DO storage enforces the 100-parameter limit, so this test fails on it if ids are bound one by one. Task 5 repeats it on a real celld.
4. **Invalid input** (wrong dims, a NaN component, an unsafe id) rejects with a clear message and writes nothing. Test: Task 2, "rejects invalid input".
5. **An empty index, or `k` larger than the stored count,** returns what exists and never throws. Test: Task 2, "empty index and k > n".

---

## File Structure

```
packages/db-sqlite-index/
  package.json              exports "./vector" and "./ngram" (P3 owns ./ngram)
  tsconfig.json             repo standard, noUncheckedIndexedAccess off (typed-array hot loops)
  tsdown.config.ts          one entry per existing subpath
  README.md                 package README (vector part here; P3 adds the n-gram part)
  bench/vector-bench.ts     `pnpm bench`: 50k × 384 upsert / compact / size / recall / latency
  src/vector/
    index.ts                public exports of ./vector
    types.ts                Metric, SearchHit, SearchOptions, BLOB <-> Float32 helpers   (core)
    math.ts                 verbatim from 0.1.0                                           (core)
    kmeans.ts               verbatim from 0.1.0                                           (core)
    segment.ts              I/O-free segment codec + SegmentIndex (probe, 1-bit filter, int8)  (core)
    segment.test.ts         codec seam: flat/IVF split, every row kept, self ranks first
    sql-segment-store.ts    segment rows in {p}centroids / {p}seg / {p}f32, parts, LRU cache
    vector-index.ts         VectorIndex over Db
    test-fixtures.ts        backends (node:sqlite, fake DO), dataset, brute force, recall
    vector-index.test.ts    the 7 ported 0.1.0 cases × 2 backends
    vector-lifecycle.test.ts probe-all identity, parts, search during merge, many ids, invalid input, k > n
    auto-compact.test.ts    auto-compaction at the default threshold
.changeset/db-sqlite-index-vector.md
```

**Tables** (`{p}` = `prefix`, e.g. `vec_`):

```sql
CREATE TABLE {p}meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);                 -- 'config', 'state'
CREATE TABLE {p}ids  (id INTEGER PRIMARY KEY, gen INTEGER NOT NULL);         -- 0 = tail
CREATE TABLE {p}tail (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, vec BLOB NOT NULL);
CREATE TABLE {p}centroids (gen INTEGER, list INTEGER, count INTEGER NOT NULL, centroid BLOB NOT NULL,
                           PRIMARY KEY (gen, list)) WITHOUT ROWID;
CREATE TABLE {p}seg (gen INTEGER, list INTEGER, part INTEGER, bytes BLOB NOT NULL,
                     PRIMARY KEY (gen, list, part)) WITHOUT ROWID;              -- searchable block
CREATE TABLE {p}f32 (gen INTEGER, list INTEGER, part INTEGER, bytes BLOB NOT NULL,
                     PRIMARY KEY (gen, list, part)) WITHOUT ROWID;              -- float32 block
```

---

### Task 1: Package skeleton and the I/O-free core (math, k-means, segment codec)

**Files:**
- Create: `packages/db-sqlite-index/package.json`, `tsconfig.json`, `tsdown.config.ts`
- Create: `packages/db-sqlite-index/src/vector/types.ts`, `math.ts` (verbatim), `kmeans.ts` (verbatim), `segment.ts`
- Test: `packages/db-sqlite-index/src/vector/segment.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, in `segment.ts`:
  - `MIN_TRAIN = 2048`
  - `defaultNlist(n: number): number`
  - `listLayout(count: number, dims: number): ListLayout`
  - `buildSegment(input: BuildInput): BuiltSegment`, where `BuildInput = { dims, metric, ids: Float64Array, vectors: Float32Array, nlist?, seed? }` and `BuiltSegment = { nlist: number; counts: Uint32Array; centroids: Float32Array; lists: Uint8Array[]; floats: Uint8Array[] }`
  - `parseList(bytes: Uint8Array, count: number, dims: number): ListData`
  - `class SegmentIndex(gen, dims, metric, centroids, counts)` with `nlist`, `probe(q, nprobe): number[]`, `filterList(q, c, data, limit, keep?): Candidate[]`, `scoreInt8(q, data, row): number`
  - `type Candidate = { list: number; row: number; id: number }`
- Produces, in `types.ts`:
  - `Metric`, `SearchHit`, `SearchOptions`
  - `toFloat32(bytes: Uint8Array): Float32Array`
  - `float32Bytes(v: Float32Array): Uint8Array`

The skeleton is shared with P3, so whichever plan lands first creates it:
- If `packages/db-sqlite-index/package.json` already exists, don't recreate it. Only make sure `exports["./vector"]` exists and add the `vector` entry to `tsdown.config.ts`.
- `exports` lists both subpaths from the start.
- `tsdown.config.ts` lists only the entries whose `src/<name>/index.ts` exists. The second plan to land adds its line.

- [ ] **Step 1: Create the package skeleton**

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

`packages/db-sqlite-index/tsdown.config.ts` (if P3 landed first, add only the `vector` line):

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    vector: "src/vector/index.ts",
  },
  format: "esm",
  dts: true,
});
```

Run: `pnpm install` (from the `statewalker-db` root)
Expected: the lockfile gains `packages/db-sqlite-index` and the install succeeds.

- [ ] **Step 2: Copy the unchanged core from 0.1.0**

```bash
ARCH=$(mktemp -d) \
  && tar -xzf ~/workspace-statewalker/notes/drive/2026-09-17.Vector-Index/code-vector-index.tar.gz -C "$ARCH" \
  && mkdir -p packages/db-sqlite-index/src/vector \
  && cp "$ARCH/vector-index/src/math.ts" "$ARCH/vector-index/src/kmeans.ts" packages/db-sqlite-index/src/vector/ \
  && rm -rf "$ARCH"
```

`math.ts` and `kmeans.ts` only import `type Metric` from `./types.js`, so they stay verbatim.

Write `packages/db-sqlite-index/src/vector/types.ts`. The `SqlDriver`/`RangeFiles` ports and the metric codes are gone, because segments no longer have a binary header:

```ts
export type Metric = "cosine" | "dot" | "l2";

export interface SearchHit {
  id: number;
  /** Lower is closer: 1 - cos for cosine, -dot for dot, squared L2 for l2. */
  distance: number;
}

export interface SearchOptions {
  k?: number;
  /** IVF lists probed per segment. Default 8. */
  nprobe?: number;
  /** Candidates kept per probed list by the 1-bit filter = k * oversample. Default 8. */
  oversample?: number;
  /** Re-rank the int8 winners with the stored float32 vectors. Default false. */
  exact?: boolean;
  /** Keep only ids for which this returns true (applied before re-ranking). */
  filter?: (id: number) => boolean;
  signal?: AbortSignal;
}

/** An aligned Float32Array copy of BLOB bytes (views over arbitrary offsets are unsafe). */
export function toFloat32(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, 0, copy.byteLength >> 2);
}

export function float32Bytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
}
```

- [ ] **Step 3: Write the failing codec test**

`packages/db-sqlite-index/src/vector/segment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mulberry32 } from "./kmeans.js";
import { prepare } from "./math.js";
import { buildSegment, MIN_TRAIN, parseList, SegmentIndex } from "./segment.js";

const D = 32;

function clustered(n: number, seed: number): { ids: Float64Array; vectors: Float32Array } {
  const r = mulberry32(seed);
  const centers = Array.from({ length: 20 }, () => Float32Array.from({ length: D }, () => r() * 2 - 1));
  const vectors = new Float32Array(n * D);
  for (let i = 0; i < n; i++) {
    const c = centers[Math.floor(r() * centers.length)] as Float32Array;
    vectors.set(prepare(c.map((x) => x + (r() - 0.5) * 0.6), D, "cosine"), i * D);
  }
  return { ids: Float64Array.from({ length: n }, (_, i) => i + 1), vectors };
}

describe("segment codec", () => {
  it("is one flat list below MIN_TRAIN and several lists from MIN_TRAIN on", () => {
    const small = clustered(MIN_TRAIN - 1, 1);
    const large = clustered(MIN_TRAIN, 1);
    expect(buildSegment({ dims: D, metric: "cosine", ...small }).nlist).toBe(1);
    expect(buildSegment({ dims: D, metric: "cosine", ...large }).nlist).toBeGreaterThan(1);
  });

  it("keeps every row exactly once, and a stored vector ranks itself first", () => {
    const { ids, vectors } = clustered(3000, 2);
    const built = buildSegment({ dims: D, metric: "cosine", ids, vectors });
    const seg = new SegmentIndex(1, D, "cosine", built.centroids, built.counts);
    const lists = built.lists.map((bytes, c) => parseList(bytes, built.counts[c] as number, D));

    const seen = lists.flatMap((l) => Array.from(l.ids)).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from(ids));

    const q = vectors.subarray(0, D);
    let best = { id: -1, d: Number.POSITIVE_INFINITY };
    for (const c of seg.probe(q, seg.nlist)) {
      const data = lists[c];
      if (!data) continue;
      for (const cand of seg.filterList(q, c, data, 50)) {
        const d = seg.scoreInt8(q, data, cand.row);
        if (d < best.d) best = { id: cand.id, d };
      }
    }
    expect(best.id).toBe(1);
  });

  it("rejects a list block of the wrong size", () => {
    expect(() => parseList(new Uint8Array(10), 3, D)).toThrow(/list block has 10 bytes/);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `pnpm --filter @statewalker/db-sqlite-index exec vitest run src/vector/segment.test.ts`
Expected: FAIL, `Failed to resolve import "./segment.js"`.

- [ ] **Step 5: Write `segment.ts`**

This is the 0.1.0 codec without I/O. The file header, directory and offsets are replaced by per-list blocks that each start at byte 0. The 1-bit, int8 and probe math is unchanged.

```ts
import { kmeans, nearest } from "./kmeans.js";
import {
  distance,
  distanceInt8,
  hamming,
  quantizeInt8,
  residualBits,
  TopK,
  wordsFor,
} from "./math.js";
import type { Metric } from "./types.js";

/**
 * An IVF segment as storage-neutral parts. This module does no I/O; a store
 * decides where the parts live.
 *
 *   per list: a centroid f32[dims] and a row count
 *   per list, the searchable block (little-endian, each section padded to 8 bytes):
 *     ids f64[count] | bits u32[count × words] | rnorm f32[count] | cdot f32[count]
 *     scales f32[count] | codes i8[count × dims]
 *   per list, the float block f32[count × dims] (exact re-rank, lossless merge, read-back)
 *
 *   bits  = signs of the residual r = x - c (c = the list centroid)
 *   rnorm = |r|, cdot = c·r. With them the 1-bit stage estimates the real
 *   metric, RaBitQ-style: r_q·r ≈ |r_q| |r| cos(π · hamming / dims).
 */
const align8 = (n: number) => (n + 7) & ~7;

export interface ListLayout {
  count: number;
  idsAt: number;
  bitsAt: number;
  rnormAt: number;
  cdotAt: number;
  scalesAt: number;
  codesAt: number;
  /** Bytes of the searchable block. */
  length: number;
}

export function listLayout(count: number, dims: number): ListLayout {
  const w = wordsFor(dims);
  const idsAt = 0;
  const bitsAt = align8(idsAt + 8 * count);
  const rnormAt = align8(bitsAt + 4 * w * count);
  const cdotAt = align8(rnormAt + 4 * count);
  const scalesAt = align8(cdotAt + 4 * count);
  const codesAt = align8(scalesAt + 4 * count);
  const length = align8(codesAt + dims * count);
  return { count, idsAt, bitsAt, rnormAt, cdotAt, scalesAt, codesAt, length };
}

// ------------------------------------------------------------------ build

export interface BuildInput {
  dims: number;
  metric: Metric;
  ids: Float64Array;
  /** n × dims, already prepared (normalized for cosine). */
  vectors: Float32Array;
  nlist?: number;
  seed?: number;
}

export interface BuiltSegment {
  nlist: number;
  counts: Uint32Array;
  /** nlist × dims */
  centroids: Float32Array;
  /** Searchable block per list. */
  lists: Uint8Array[];
  /** Float32 block per list. */
  floats: Uint8Array[];
}

/** Below this size a segment is a single flat list: training would not pay off. */
export const MIN_TRAIN = 2048;

export function defaultNlist(n: number) {
  if (n < MIN_TRAIN) return 1;
  return Math.max(1, Math.min(1024, Math.round(Math.sqrt(n))));
}

export function buildSegment(input: BuildInput): BuiltSegment {
  const { dims: d, metric, ids, vectors } = input;
  const n = ids.length;
  const nlist = Math.max(1, Math.min(input.nlist ?? defaultNlist(n), Math.max(1, n)));

  let centroids: Float32Array;
  if (nlist === 1) {
    centroids = new Float32Array(d);
    for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) centroids[j] += vectors[i * d + j];
    if (n > 0) for (let j = 0; j < d; j++) centroids[j] /= n;
  } else {
    centroids = kmeans(vectors, n, d, nlist, metric, { seed: input.seed });
  }

  const assign = new Uint32Array(n);
  const counts = new Uint32Array(nlist);
  for (let i = 0; i < n; i++) {
    const c = nlist === 1 ? 0 : nearest(metric, vectors, i * d, centroids, nlist, d);
    assign[i] = c;
    counts[c]++;
  }

  const w = wordsFor(d);
  const layouts = Array.from(counts, (count) => listLayout(count, d));
  const lists = layouts.map((l) => new Uint8Array(l.length));
  const floats = Array.from(counts, (count) => new Uint8Array(4 * count * d));
  const views = layouts.map((l, c) => {
    const buf = lists[c].buffer;
    return {
      ids: new Float64Array(buf, l.idsAt, l.count),
      bits: new Uint32Array(buf, l.bitsAt, l.count * w),
      rnorm: new Float32Array(buf, l.rnormAt, l.count),
      cdot: new Float32Array(buf, l.cdotAt, l.count),
      scales: new Float32Array(buf, l.scalesAt, l.count),
      codes: new Int8Array(buf, l.codesAt, l.count * d),
      floats: new Float32Array(floats[c].buffer, 0, l.count * d),
    };
  });

  const fill = new Uint32Array(nlist);
  for (let i = 0; i < n; i++) {
    const c = assign[i];
    const j = fill[c]++;
    const v = views[c];
    v.ids[j] = ids[i];
    residualBits(vectors, i * d, centroids, c * d, d, v.bits, j * w);
    const [rn, cd] = residualStats(vectors, i * d, centroids, c * d, d);
    v.rnorm[j] = rn;
    v.cdot[j] = cd;
    v.scales[j] = quantizeInt8(vectors, i * d, d, v.codes, j * d);
    v.floats.set(vectors.subarray(i * d, i * d + d), j * d);
  }
  return { nlist, counts, centroids, lists, floats };
}

/** [|x - c|, c·(x - c)] */
function residualStats(x: Float32Array, xo: number, c: Float32Array, co: number, d: number) {
  let nn = 0;
  let cd = 0;
  for (let i = 0; i < d; i++) {
    const r = x[xo + i] - c[co + i];
    nn += r * r;
    cd += c[co + i] * r;
  }
  return [Math.sqrt(nn), cd];
}

// ------------------------------------------------------------------ read

export interface ListData {
  ids: Float64Array;
  bits: Uint32Array;
  rnorm: Float32Array;
  cdot: Float32Array;
  scales: Float32Array;
  codes: Int8Array;
}

/** Typed views over a searchable block (copied only when it does not start at offset 0). */
export function parseList(bytes: Uint8Array, count: number, dims: number): ListData {
  const l = listLayout(count, dims);
  if (bytes.byteLength !== l.length) {
    throw new Error(`vector-index: list block has ${bytes.byteLength} bytes, expected ${l.length}`);
  }
  const buf = bytes.byteOffset === 0 ? bytes.buffer : bytes.slice().buffer;
  const w = wordsFor(dims);
  return {
    ids: new Float64Array(buf, l.idsAt, count),
    bits: new Uint32Array(buf, l.bitsAt, count * w),
    rnorm: new Float32Array(buf, l.rnormAt, count),
    cdot: new Float32Array(buf, l.cdotAt, count),
    scales: new Float32Array(buf, l.scalesAt, count),
    codes: new Int8Array(buf, l.codesAt, count * dims),
  };
}

export interface Candidate {
  list: number;
  row: number;
  id: number;
}

/** The in-memory part of a segment: centroids and list sizes. List blocks are fetched by the caller. */
export class SegmentIndex {
  constructor(
    readonly gen: number,
    readonly dims: number,
    readonly metric: Metric,
    readonly centroids: Float32Array,
    readonly counts: Uint32Array,
  ) {}

  get nlist() {
    return this.counts.length;
  }

  /** The `nprobe` non-empty lists whose centroids are closest to the query. */
  probe(query: Float32Array, nprobe: number): number[] {
    const m: Metric = this.metric === "l2" ? "l2" : "dot";
    const top = new TopK<number>(Math.min(nprobe, this.nlist));
    for (let c = 0; c < this.nlist; c++) {
      if (this.counts[c] === 0) continue;
      top.push(distance(m, query, 0, this.centroids, c * this.dims, this.dims), c);
    }
    return top.sorted().map((e) => e.item);
  }

  /**
   * Stage 1: the `limit` rows of a list with the best estimated distance, from
   * residual sign bits plus the stored residual norm and centroid projection.
   */
  filterList(
    query: Float32Array,
    c: number,
    data: ListData,
    limit: number,
    keep?: (id: number) => boolean,
  ): Candidate[] {
    const d = this.dims;
    const w = wordsFor(d);
    const co = c * d;
    const qb = new Uint32Array(w);
    residualBits(query, 0, this.centroids, co, d, qb, 0);
    const [qn, qcd] = residualStats(query, 0, this.centroids, co, d);
    let cc = 0;
    for (let i = 0; i < d; i++) cc += this.centroids[co + i] * this.centroids[co + i];
    const qc = cc + qcd; // q·c
    const angle = Math.PI / d;
    const l2 = this.metric === "l2";
    const top = new TopK<Candidate>(limit);
    for (let r = 0; r < data.ids.length; r++) {
      const id = data.ids[r];
      if (keep && !keep(id)) continue;
      const rr = qn * data.rnorm[r] * Math.cos(angle * hamming(qb, data.bits, r * w, w));
      // q·x = q·c + c·r_x + r_q·r_x ;  |q-x|² = |r_q|² + |r_x|² - 2 r_q·r_x
      const est = l2
        ? qn * qn + data.rnorm[r] * data.rnorm[r] - 2 * rr
        : -(qc + data.cdot[r] + rr);
      if (est < top.bound) top.push(est, { list: c, row: r, id });
    }
    return top.sorted().map((e) => e.item);
  }

  /** Stage 2: approximate distance from the int8 codes. */
  scoreInt8(query: Float32Array, data: ListData, row: number): number {
    return distanceInt8(this.metric, query, data.codes, row * this.dims, data.scales[row], this.dims);
  }
}
```

- [ ] **Step 6: Run the test and check that the core is I/O-free**

Run: `pnpm --filter @statewalker/db-sqlite-index exec vitest run src/vector/segment.test.ts`
Expected: PASS (3 tests).

Run: `grep -l "@statewalker/db-" packages/db-sqlite-index/src/vector/{types,math,kmeans,segment}.ts || echo core-clean`
Expected: `core-clean`

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm --filter @statewalker/db-sqlite-index typecheck
pnpm biome check --write --unsafe packages/db-sqlite-index
git add packages/db-sqlite-index pnpm-lock.yaml
git commit -m "feat(db-sqlite-index): package skeleton and I/O-free vector core (segment codec, math, k-means)"
```

Expected: typecheck and biome both exit 0. If biome reports something it cannot fix in the verbatim `math.ts`/`kmeans.ts`, fix it in place without changing behaviour.

---

### Task 2: `VectorIndex` over `Db`, the ported 0.1.0 suite and the edge cases

**Files:**
- Create: `packages/db-sqlite-index/src/vector/sql-segment-store.ts`
- Create: `packages/db-sqlite-index/src/vector/vector-index.ts`
- Create: `packages/db-sqlite-index/src/vector/index.ts`
- Create: `packages/db-sqlite-index/src/vector/test-fixtures.ts`
- Create: `packages/db-sqlite-index/README.md` (or, if P3 created it, add the vector sections)
- Test: `packages/db-sqlite-index/src/vector/vector-index.test.ts`, `packages/db-sqlite-index/src/vector/vector-lifecycle.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1: `buildSegment`, `parseList`, `SegmentIndex`, `ListData`, `Candidate`, `BuiltSegment`, `toFloat32`, `float32Bytes`, `prepare`, `distance`, `TopK`, `mulberry32`;
  - from P1: `inTransaction<T>(db: Db, cb: (tx: Db) => Promise<T>): Promise<T>` (`@statewalker/db-sqlite`), `newNodeSqliteDb(options?: DbOptions): Promise<Db>` (`@statewalker/db-sqlite-node`), `newDoSqliteDb(storage): Db` — synchronous (`@statewalker/db-sqlite-do`), `newFakeDoStorage()` (`@statewalker/db-sqlite-do/fake`).
- Produces (public, `./vector`; P5 consumes these):
  - `class VectorIndex` with:
    - `constructor(opts: VectorIndexOptions)`
    - `init(): Promise<void>`
    - `refresh(): Promise<void>`
    - `get stats(): VectorIndexStats`
    - `upsert(items: VectorItem[]): Promise<void>`
    - `delete(ids: number[]): Promise<void>`
    - `search(query: ArrayLike<number>, opts?: SearchOptions): Promise<SearchHit[]>`
    - `compact(): Promise<number>`
    - `merge(): Promise<number>`
    - `optimize(): Promise<void>`
    - `getVectors(ids: number[]): Promise<Map<number, Float32Array>>` — live ids only, vectors **as stored** (normalised to unit length for `cosine`); unknown or deleted ids are absent
    - `readonly idTable: string` — `${prefix}ids`, a table whose `id INTEGER` column holds exactly the live ids. Public contract: P5 joins it in SQL for size and enumeration
  - `dropVectorIndex(db: Db, prefix: string): Promise<void>` — drops every table of the index, in one `inTransaction`; needs no `dims`
  - `VectorIndexOptions = { db: Db; prefix: string; dims: number; metric?: Metric; nlist?: (n: number) => number; cacheBytes?: number }` (Task 3 adds `autoCompactAt?`)
  - `VectorItem = { id: number; vector: ArrayLike<number> }`
  - `VectorIndexStats = { tail: number; segments: SegmentRef[]; seq: number }`
  - `SegmentRef = { gen: number; count: number; nlist: number }`
  - the types `Metric`, `SearchHit`, `SearchOptions`
- Produces for tests: `test-fixtures.ts` exports `BACKENDS`, `D`, `dataset`, `bruteForce`, `recall`.

- [ ] **Step 1: Build the P1 dependencies the tests import**

Run: `pnpm --filter "@statewalker/db-sqlite-index^..." build`
Expected: `db-api`, `db-sqlite`, `db-sqlite-node` and `db-sqlite-do` build without errors. Tests resolve workspace packages through their `dist`.

- [ ] **Step 2: Write the test fixtures**

`packages/db-sqlite-index/src/vector/test-fixtures.ts`:

```ts
import type { Db } from "@statewalker/db-api";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { mulberry32 } from "./kmeans.js";
import { distance, prepare } from "./math.js";
import type { Metric, SearchOptions } from "./types.js";
import type { VectorIndex } from "./vector-index.js";

/** Every suite runs over each of these. */
export const BACKENDS: Record<string, () => Promise<Db>> = {
  "node:sqlite": () => newNodeSqliteDb(),
  "durable object (fake storage)": async () => newDoSqliteDb(newFakeDoStorage()),
};

export const D = 64;

export interface Item {
  id: number;
  vector: Float32Array;
}

/** Clustered data: realistic for IVF (uniform noise makes every ANN look bad). */
export function dataset(n: number, seed: number, dims = D, clusters = 40): Item[] {
  const r = mulberry32(seed);
  const centers = Array.from({ length: clusters }, () =>
    Float32Array.from({ length: dims }, () => r() * 2 - 1),
  );
  return Array.from({ length: n }, (_, i) => {
    const c = centers[Math.floor(r() * clusters)] as Float32Array;
    return { id: i + 1, vector: Float32Array.from(c, (x) => x + (r() - 0.5) * 0.6) };
  });
}

export function bruteForce(items: Item[], q: Float32Array, k: number, metric: Metric, dims = D) {
  const qq = prepare(q, dims, metric);
  return items
    .map((it) => ({ id: it.id, d: distance(metric, qq, 0, prepare(it.vector, dims, metric), 0, dims) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((x) => x.id);
}

export async function recall(
  index: VectorIndex,
  items: Item[],
  metric: Metric,
  opts: SearchOptions = {},
): Promise<number> {
  const r = mulberry32(7);
  let hit = 0;
  const Q = 30;
  for (let i = 0; i < Q; i++) {
    const base = items[Math.floor(r() * items.length)] as Item;
    const q = base.vector.map((x) => x + (r() - 0.5) * 0.2);
    const truth = new Set(bruteForce(items, q, 10, metric));
    const got = await index.search(q, { k: 10, ...opts });
    hit += got.filter((h) => truth.has(h.id)).length;
  }
  return hit / (Q * 10);
}
```

- [ ] **Step 3: Write the failing ported suite (the 7 cases of 0.1.0)**

`packages/db-sqlite-index/src/vector/vector-index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BACKENDS, D, dataset, recall } from "./test-fixtures.js";
import type { Metric } from "./types.js";
import { VectorIndex } from "./vector-index.js";

for (const [name, open] of Object.entries(BACKENDS)) {
  describe(`VectorIndex over ${name}`, { timeout: 60_000 }, () => {
    async function setup(metric: Metric = "cosine") {
      const db = await open();
      const index = new VectorIndex({ db, prefix: "vec_", dims: D, metric });
      await index.init();
      return { db, index };
    }

    it("tail search is exact", async () => {
      const { index } = await setup();
      const items = dataset(300, 1);
      await index.upsert(items);
      expect(await recall(index, items, "cosine")).toBe(1);
    });

    for (const metric of ["cosine", "dot", "l2"] as const) {
      it(`compacted IVF segment has high recall (${metric})`, async () => {
        const { index } = await setup(metric);
        const items = dataset(5000, 2);
        await index.upsert(items);
        expect(await index.compact()).toBe(5000);
        expect(index.stats.tail).toBe(0);
        const approx = await recall(index, items, metric, { nprobe: 12 });
        const exact = await recall(index, items, metric, { nprobe: 12, exact: true });
        console.log(`  ${name} ${metric}: recall@10 int8=${approx.toFixed(3)} exact=${exact.toFixed(3)}`);
        expect(approx).toBeGreaterThanOrEqual(0.85);
        expect(exact).toBeGreaterThanOrEqual(approx - 0.01);
      });
    }

    it("deletes and overwrites hide segment copies; merge drops them", async () => {
      const { index, db } = await setup();
      const items = dataset(2000, 3);
      await index.upsert(items);
      await index.compact();

      const target = items[10];
      expect((await index.search(target.vector, { k: 1 }))[0]?.id).toBe(target.id);

      await index.delete([target.id]);
      const after = await index.search(target.vector, { k: 5 });
      expect(after.some((h) => h.id === target.id)).toBe(false);

      // Overwrite id 20 with the vector of id 30: a search for 30's vector finds both.
      await index.upsert([{ id: 20, vector: items[29].vector }]);
      const both = (await index.search(items[29].vector, { k: 2 })).map((h) => h.id).sort((a, b) => a - b);
      expect(both).toEqual([20, 30]);
      // The old copy of id 20 (still in the segment) must not show up for its old vector.
      const old = await index.search(items[19].vector, { k: 3 });
      expect(old.every((h) => h.id !== 20 || h.distance > 1e-4)).toBe(true);

      await index.compact(); // a second segment holds the new id 20
      expect(index.stats.segments.length).toBe(2);
      expect(await index.merge()).toBe(1999);
      expect(index.stats.segments.length).toBe(1);
      const both2 = (await index.search(items[29].vector, { k: 2 })).map((h) => h.id).sort((a, b) => a - b);
      expect(both2).toEqual([20, 30]);
      const [row] = await db.query<{ n: number }>("SELECT count(*) AS n FROM vec_ids");
      expect(Number(row?.n)).toBe(1999);
    });

    it("state survives a reopen", async () => {
      const { index, db } = await setup();
      const items = dataset(1500, 4);
      await index.upsert(items.slice(0, 1200));
      await index.compact();
      await index.upsert(items.slice(1200));
      const reopened = new VectorIndex({ db, prefix: "vec_", dims: D });
      await reopened.init();
      expect(reopened.stats.tail).toBe(300);
      expect(reopened.stats.segments.length).toBe(1);
      expect(await recall(reopened, items, "cosine", { nprobe: 16 })).toBeGreaterThanOrEqual(0.85);
    });

    it("filters and rejects a mismatched configuration", async () => {
      const { index, db } = await setup();
      const items = dataset(1200, 5);
      await index.upsert(items);
      await index.compact();
      const even = await index.search(items[0].vector, { k: 10, filter: (id) => id % 2 === 0 });
      expect(even.length).toBe(10);
      expect(even.every((h) => h.id % 2 === 0)).toBe(true);
      const wrong = new VectorIndex({ db, prefix: "vec_", dims: D + 1 });
      await expect(wrong.init()).rejects.toThrow(/created with/);
    });
  });
}
```

- [ ] **Step 4: Write the failing edge-case suite (the Review Focus lines, plus probe-all identity)**

`packages/db-sqlite-index/src/vector/vector-lifecycle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PART_BYTES } from "./sql-segment-store.js";
import { BACKENDS, bruteForce, D, dataset } from "./test-fixtures.js";
import { dropVectorIndex, VectorIndex } from "./vector-index.js";

for (const [name, open] of Object.entries(BACKENDS)) {
  describe(`VectorIndex lifecycle over ${name}`, { timeout: 60_000 }, () => {
    async function setup(dims = D) {
      const db = await open();
      const index = new VectorIndex({ db, prefix: "vec_", dims });
      await index.init();
      return { db, index };
    }

    it("probing every list with exact re-rank equals brute force", async () => {
      const { index } = await setup();
      const items = dataset(3000, 11);
      await index.upsert(items);
      await index.compact();
      expect(index.stats.segments[0]?.nlist).toBeGreaterThan(1);
      for (const it of items.slice(0, 20)) {
        const q = it.vector.map((x) => x + 0.01);
        const got = await index.search(q, { k: 10, nprobe: 1e6, oversample: 1e6, exact: true });
        expect(got.map((h) => h.id)).toEqual(bruteForce(items, q, 10, "cosine"));
      }
    });

    it("empty index and k > n return what exists", async () => {
      const { index } = await setup();
      const q = dataset(1, 12)[0]?.vector as Float32Array;
      expect(await index.search(q, { k: 10 })).toEqual([]);
      await index.upsert(dataset(5, 12));
      expect((await index.search(q, { k: 10 })).length).toBe(5);
      await index.compact();
      expect((await index.search(q, { k: 10 })).length).toBe(5);
    });

    it("rejects invalid input and writes nothing", async () => {
      const { index } = await setup();
      await expect(index.upsert([{ id: 1, vector: new Float32Array(D + 1) }])).rejects.toThrow(
        /expected 64 dims/,
      );
      const nan = new Float32Array(D);
      nan[3] = Number.NaN;
      await expect(index.upsert([{ id: 1, vector: nan }])).rejects.toThrow(/non-finite/);
      await expect(index.upsert([{ id: 2 ** 53, vector: new Float32Array(D) }])).rejects.toThrow(
        /safe integer/,
      );
      expect(index.stats.tail).toBe(0);
    });

    it("deletes many ids in one call", async () => {
      const { index } = await setup();
      const items = dataset(400, 13);
      await index.upsert(items);
      await index.compact();
      const gone = items.slice(0, 150).map((it) => it.id);
      await index.delete(gone);
      const dead = new Set(gone);
      for (const it of items.slice(0, 10)) {
        const hits = await index.search(it.vector, { k: 20 });
        expect(hits.some((h) => dead.has(h.id))).toBe(false);
      }
    });

    it("splits list blocks into parts no larger than PART_BYTES", async () => {
      const dims = 768;
      const { db, index } = await setup(dims);
      const items = dataset(1500, 14, dims); // flat: one list of ~1.3 MB, floats ~4.6 MB
      await index.upsert(items);
      await index.compact();
      const [seg] = await db.query<{ n: number; max: number }>(
        "SELECT count(*) AS n, max(length(bytes)) AS max FROM vec_seg",
      );
      const [f32] = await db.query<{ n: number; max: number }>(
        "SELECT count(*) AS n, max(length(bytes)) AS max FROM vec_f32",
      );
      expect(Number(seg?.n)).toBeGreaterThanOrEqual(2);
      expect(Number(f32?.n)).toBeGreaterThanOrEqual(5);
      expect(Math.max(Number(seg?.max), Number(f32?.max))).toBeLessThanOrEqual(PART_BYTES);
      for (const it of items.slice(0, 10)) {
        expect((await index.search(it.vector, { k: 1, exact: true }))[0]?.id).toBe(it.id);
      }
    });

    it("getVectors returns live stored vectors from the tail and from segments", async () => {
      const { index } = await setup();
      const items = dataset(300, 16);
      await index.upsert(items.slice(0, 200));
      await index.compact();
      await index.upsert(items.slice(200));
      await index.delete([5]);
      const got = await index.getVectors([1, 5, 250, 9999]);
      expect([...got.keys()].sort((a, b) => a - b)).toEqual([1, 250]);
      for (const id of [1, 250]) {
        const want = items[id - 1]?.vector as Float32Array;
        const norm = Math.hypot(...want);
        const v = got.get(id) as Float32Array;
        for (let j = 0; j < D; j++) expect(v[j]).toBeCloseTo((want[j] as number) / norm, 5);
      }
    });

    it("dropVectorIndex removes every table; the prefix can be reused", async () => {
      const { db, index } = await setup();
      await index.upsert(dataset(50, 17));
      await index.compact();
      await dropVectorIndex(db, "vec_");
      const left = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec\\_%' ESCAPE '\\'",
      );
      expect(left).toEqual([]);
      const fresh = new VectorIndex({ db, prefix: "vec_", dims: D * 2 });
      await fresh.init();
      expect(fresh.stats.tail).toBe(0);
    });

    it("search during merge returns correct hits; retired rows are gone after reopen", async () => {
      const { db, index } = await setup();
      const items = dataset(1200, 15);
      await index.upsert(items.slice(0, 600));
      await index.compact();
      await index.upsert(items.slice(600));
      await index.compact();
      const target = items[700] as (typeof items)[number];
      const [hits] = await Promise.all([index.search(target.vector, { k: 1 }), index.merge()]);
      expect(hits[0]?.id).toBe(target.id);

      const reopened = new VectorIndex({ db, prefix: "vec_", dims: D });
      await reopened.init();
      const [row] = await db.query<{ n: number }>("SELECT count(DISTINCT gen) AS n FROM vec_seg");
      expect(Number(row?.n)).toBe(1);
      expect((await reopened.search(target.vector, { k: 1 }))[0]?.id).toBe(target.id);
    });
  });
}
```

- [ ] **Step 5: Run both suites to make sure they fail**

Run: `pnpm --filter @statewalker/db-sqlite-index exec vitest run src/vector/vector-index.test.ts src/vector/vector-lifecycle.test.ts`
Expected: FAIL, `Failed to resolve import "./vector-index.js"` (and `./sql-segment-store.js`).

- [ ] **Step 6: Write `sql-segment-store.ts`**

```ts
import type { Db } from "@statewalker/db-api";
import { type BuiltSegment, type ListData, parseList, SegmentIndex } from "./segment.js";
import { float32Bytes, type Metric, toFloat32 } from "./types.js";

/**
 * Largest BLOB written in one row. Durable Object SQLite rejects values over
 * ~2 MB ("string or blob too big"); 1 MiB leaves headroom.
 */
export const PART_BYTES = 1024 * 1024;

export interface SegmentRef {
  gen: number;
  count: number;
  nlist: number;
}

/**
 * Segment rows: one centroid row per list, and each list's searchable and
 * float32 blocks split into parts. Reads go through an LRU cache: a
 * generation is immutable, so cached blocks never go stale.
 */
export class SqlSegmentStore {
  readonly #db: Db;
  readonly #dims: number;
  readonly #t: { centroids: string; seg: string; f32: string };
  readonly #cache: Lru<ListData | Float32Array>;

  constructor(db: Db, prefix: string, dims: number, cacheBytes = 64 * 1024 * 1024) {
    this.#db = db;
    this.#dims = dims;
    this.#t = { centroids: `${prefix}centroids`, seg: `${prefix}seg`, f32: `${prefix}f32` };
    this.#cache = new Lru(cacheBytes);
  }

  schema(): string[] {
    const { centroids, seg, f32 } = this.#t;
    return [
      `CREATE TABLE IF NOT EXISTS ${centroids}(gen INTEGER, list INTEGER, count INTEGER NOT NULL,
         centroid BLOB NOT NULL, PRIMARY KEY (gen, list)) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS ${seg}(gen INTEGER, list INTEGER, part INTEGER,
         bytes BLOB NOT NULL, PRIMARY KEY (gen, list, part)) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS ${f32}(gen INTEGER, list INTEGER, part INTEGER,
         bytes BLOB NOT NULL, PRIMARY KEY (gen, list, part)) WITHOUT ROWID`,
    ];
  }

  /** Writes every row of a built segment. Call inside `inTransaction`. */
  async write(tx: Db, gen: number, built: BuiltSegment): Promise<void> {
    const d = this.#dims;
    for (let c = 0; c < built.nlist; c++) {
      await tx.query(
        `INSERT INTO ${this.#t.centroids}(gen, list, count, centroid) VALUES (?, ?, ?, ?)`,
        [gen, c, built.counts[c], float32Bytes(built.centroids.subarray(c * d, (c + 1) * d))],
      );
      await writeParts(tx, this.#t.seg, gen, c, built.lists[c] as Uint8Array);
      await writeParts(tx, this.#t.f32, gen, c, built.floats[c] as Uint8Array);
    }
  }

  /** Loads the in-memory part (centroids, list sizes) of a committed segment. */
  async open(ref: SegmentRef, metric: Metric): Promise<SegmentIndex> {
    const d = this.#dims;
    const rows = await this.#db.query<{ list: number; count: number; centroid: Uint8Array }>(
      `SELECT list, count, centroid FROM ${this.#t.centroids} WHERE gen = ? ORDER BY list`,
      [ref.gen],
    );
    if (rows.length !== ref.nlist) {
      throw new Error(`vector-index: segment ${ref.gen} has ${rows.length} lists, expected ${ref.nlist}`);
    }
    const centroids = new Float32Array(ref.nlist * d);
    const counts = new Uint32Array(ref.nlist);
    for (const r of rows) {
      const c = Number(r.list);
      centroids.set(toFloat32(r.centroid), c * d);
      counts[c] = Number(r.count);
    }
    return new SegmentIndex(ref.gen, d, metric, centroids, counts);
  }

  /** Searchable blocks of lists `cs`: cached ones from memory, the rest in one query. */
  async lists(seg: SegmentIndex, cs: number[]): Promise<ListData[]> {
    const out = new Map<number, ListData>();
    const missing: number[] = [];
    for (const c of cs) {
      const hit = this.#cache.get(`s:${seg.gen}:${c}`) as ListData | undefined;
      if (hit) out.set(c, hit);
      else missing.push(c);
    }
    if (missing.length > 0) {
      const blocks = await readParts(this.#db, this.#t.seg, seg.gen, missing);
      for (const c of missing) {
        const bytes = blocks.get(c) ?? new Uint8Array(0);
        const data = parseList(bytes, seg.counts[c] as number, this.#dims);
        this.#cache.set(`s:${seg.gen}:${c}`, data, bytes.byteLength);
        out.set(c, data);
      }
    }
    return cs.map((c) => out.get(c) as ListData);
  }

  /** Every float32 vector of list `c` (count × dims). */
  async floats(seg: SegmentIndex, c: number): Promise<Float32Array> {
    const key = `f:${seg.gen}:${c}`;
    const hit = this.#cache.get(key) as Float32Array | undefined;
    if (hit) return hit;
    const blocks = await readParts(this.#db, this.#t.f32, seg.gen, [c]);
    const floats = toFloat32(blocks.get(c) ?? new Uint8Array(0));
    this.#cache.set(key, floats, floats.byteLength);
    return floats;
  }

  /** Deletes the rows of `gens`. Call inside `inTransaction`. */
  async drop(tx: Db, gens: number[]): Promise<void> {
    const json = JSON.stringify(gens);
    for (const table of Object.values(this.#t)) {
      await tx.query(`DELETE FROM ${table} WHERE gen IN (SELECT value FROM json_each(?))`, [json]);
    }
    for (const gen of gens) this.#cache.deletePrefix(`s:${gen}:`, `f:${gen}:`);
  }

  /** Deletes rows of every generation not in `live` (left by a crash before a reap). */
  async sweep(tx: Db, live: number[]): Promise<void> {
    const json = JSON.stringify(live);
    for (const table of Object.values(this.#t)) {
      await tx.query(`DELETE FROM ${table} WHERE gen NOT IN (SELECT value FROM json_each(?))`, [json]);
    }
  }
}

async function writeParts(tx: Db, table: string, gen: number, list: number, bytes: Uint8Array) {
  for (let part = 0, at = 0; at < bytes.byteLength; part++, at += PART_BYTES) {
    await tx.query(`INSERT INTO ${table}(gen, list, part, bytes) VALUES (?, ?, ?, ?)`, [
      gen,
      list,
      part,
      bytes.slice(at, at + PART_BYTES),
    ]);
  }
}

/** The joined parts of each list in `lists`, as fresh arrays starting at offset 0. */
async function readParts(
  db: Db,
  table: string,
  gen: number,
  lists: number[],
): Promise<Map<number, Uint8Array>> {
  const rows = await db.query<{ list: number; bytes: Uint8Array }>(
    `SELECT list, bytes FROM ${table}
     WHERE gen = ? AND list IN (SELECT value FROM json_each(?)) ORDER BY list, part`,
    [gen, JSON.stringify(lists)],
  );
  const parts = new Map<number, Uint8Array[]>();
  for (const r of rows) {
    const list = Number(r.list);
    const acc = parts.get(list) ?? [];
    acc.push(r.bytes);
    parts.set(list, acc);
  }
  const out = new Map<number, Uint8Array>();
  for (const [list, ps] of parts) {
    const joined = new Uint8Array(ps.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of ps) {
      joined.set(p, at);
      at += p.byteLength;
    }
    out.set(list, joined);
  }
  return out;
}

/** Byte-budgeted LRU; Map order is LRU order (re-inserted on every hit). */
class Lru<V> {
  readonly #max: number;
  readonly #map = new Map<string, { value: V; size: number }>();
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#max = maxBytes;
  }

  get(key: string): V | undefined {
    const e = this.#map.get(key);
    if (!e) return undefined;
    this.#map.delete(key);
    this.#map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, size: number) {
    const old = this.#map.get(key);
    if (old) {
      this.#map.delete(key);
      this.#bytes -= old.size;
    }
    this.#map.set(key, { value, size });
    this.#bytes += size;
    for (const [k, e] of this.#map) {
      if (this.#bytes <= this.#max) break;
      this.#map.delete(k);
      this.#bytes -= e.size;
    }
  }

  deletePrefix(...prefixes: string[]) {
    for (const [k, e] of this.#map) {
      if (prefixes.some((p) => k.startsWith(p))) {
        this.#map.delete(k);
        this.#bytes -= e.size;
      }
    }
  }
}
```

- [ ] **Step 7: Write `vector-index.ts`**

```ts
import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";
import { distance, prepare, TopK } from "./math.js";
import { type BuiltSegment, buildSegment, type Candidate, type ListData, SegmentIndex } from "./segment.js";
import { type SegmentRef, SqlSegmentStore } from "./sql-segment-store.js";
import { float32Bytes, type Metric, type SearchHit, type SearchOptions, toFloat32 } from "./types.js";

export interface VectorIndexOptions {
  db: Db;
  /** Table name prefix, e.g. "vec_". Letters, digits and underscores. */
  prefix: string;
  dims: number;
  metric?: Metric;
  /** IVF lists for a new segment of n vectors. Default ~sqrt(n), flat below 2048. */
  nlist?: (n: number) => number;
  /** Cache budget for list blocks read from SQLite, in bytes. Default 64 MiB. */
  cacheBytes?: number;
}

export interface VectorItem {
  /** A safe integer: typically the rowid of your documents table. */
  id: number;
  vector: ArrayLike<number>;
}

export interface VectorIndexStats {
  tail: number;
  segments: SegmentRef[];
  seq: number;
}

interface State {
  seq: number;
  nextGen: number;
  segments: SegmentRef[];
}

interface TailEntry {
  seq: number;
  vector: Float32Array;
}

/** Ids per lookup (bound as one JSON parameter). */
const VALIDATE_BATCH = 2000;
/** Upserted rows per transaction. */
const WRITE_BATCH = 200;

/**
 * An LSM-style vector index over a `Db`.
 *
 * - The mutable tail lives in `{p}tail`, mirrored in memory and searched exactly.
 * - `compact()` seals the tail into an immutable IVF segment (1-bit residual
 *   filter → int8 re-rank → float32 re-rank on `exact`), written as rows in the
 *   same transaction that moves the ids out of the tail.
 * - `{p}ids(id, gen)` says which generation holds the live copy of each id
 *   (0 = tail). A segment hit counts only if its generation matches, so deletes
 *   and overwrites never touch segment rows. `merge()` rewrites all segments
 *   into one, dropping dead rows.
 *
 * One writer per database is assumed (a Durable Object, a worker, one tab);
 * within an instance, writes are serialized.
 */
export class VectorIndex {
  readonly dims: number;
  readonly metric: Metric;
  /** `{prefix}ids`: its `id` column holds exactly the live ids. Callers may join it in SQL. */
  readonly idTable: string;
  readonly #db: Db;
  readonly #store: SqlSegmentStore;
  readonly #nlist?: (n: number) => number;
  readonly #t: { meta: string; ids: string; tail: string };

  #state: State = { seq: 0, nextGen: 1, segments: [] };
  #tail = new Map<number, TailEntry>();
  #segments: SegmentIndex[] = [];
  #refs = new Map<SegmentIndex, number>();
  #retired: SegmentIndex[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #maintaining = false;
  #ready = false;

  constructor(opts: VectorIndexOptions) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.prefix)) {
      throw new Error(`vector-index: bad prefix ${opts.prefix}`);
    }
    if (!Number.isInteger(opts.dims) || opts.dims < 1) {
      throw new Error("vector-index: dims must be a positive integer");
    }
    this.dims = opts.dims;
    this.metric = opts.metric ?? "cosine";
    this.#db = opts.db;
    this.#store = new SqlSegmentStore(opts.db, opts.prefix, opts.dims, opts.cacheBytes);
    this.#nlist = opts.nlist;
    const p = opts.prefix;
    this.#t = { meta: `${p}meta`, ids: `${p}ids`, tail: `${p}tail` };
    this.idTable = this.#t.ids;
  }

  // ------------------------------------------------------------ lifecycle

  /** Creates tables if missing, loads state and sweeps rows of crashed maintenance. */
  async init(): Promise<void> {
    const { meta, ids, tail } = this.#t;
    for (const s of [
      `CREATE TABLE IF NOT EXISTS ${meta}(k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${ids}(id INTEGER PRIMARY KEY, gen INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${ids}_gen ON ${ids}(gen)`,
      `CREATE TABLE IF NOT EXISTS ${tail}(id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, vec BLOB NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${tail}_seq ON ${tail}(seq)`,
      ...this.#store.schema(),
    ]) {
      await this.#db.exec(s);
    }

    const config = JSON.stringify({ dims: this.dims, metric: this.metric });
    await this.#db.query(
      `INSERT INTO ${meta}(k, v) VALUES ('config', ?) ON CONFLICT(k) DO NOTHING`,
      [config],
    );
    const [stored] = await this.#db.query<{ v: string }>(`SELECT v FROM ${meta} WHERE k = 'config'`);
    if (stored?.v !== config) {
      throw new Error(`vector-index: tables were created with ${stored?.v}, not ${config}`);
    }
    await this.refresh();
    const live = this.#state.segments.map((s) => s.gen);
    await inTransaction(this.#db, (tx) => this.#store.sweep(tx, live));
    this.#ready = true;
  }

  /** Reloads state, tail and segments from storage (e.g. after another writer changed them). */
  async refresh(): Promise<void> {
    const [row] = await this.#db.query<{ v: string }>(
      `SELECT v FROM ${this.#t.meta} WHERE k = 'state'`,
    );
    const state: State = row ? JSON.parse(row.v) : { seq: 0, nextGen: 1, segments: [] };

    const tail = new Map<number, TailEntry>();
    const rows = await this.#db.query<{ id: number; seq: number; vec: Uint8Array }>(
      `SELECT id, seq, vec FROM ${this.#t.tail}`,
    );
    for (const r of rows) tail.set(Number(r.id), { seq: Number(r.seq), vector: toFloat32(r.vec) });

    const known = new Map(this.#segments.map((s) => [s.gen, s]));
    const segments = await Promise.all(
      state.segments.map((s) => known.get(s.gen) ?? this.#store.open(s, this.metric)),
    );
    this.#state = state;
    this.#tail = tail;
    this.#segments = segments;
  }

  get stats(): VectorIndexStats {
    return {
      tail: this.#tail.size,
      segments: this.#state.segments.map((s) => ({ ...s })),
      seq: this.#state.seq,
    };
  }

  // ------------------------------------------------------------ writes

  async upsert(items: VectorItem[]): Promise<void> {
    this.#assertReady();
    const prepared = items.map((it) => {
      assertId(it.id);
      return { id: it.id, vector: prepare(it.vector, this.dims, this.metric) };
    });
    const { tail, ids } = this.#t;
    for (let i = 0; i < prepared.length; i += WRITE_BATCH) {
      const batch = prepared.slice(i, i + WRITE_BATCH);
      await this.#exclusive(async () => {
        const seq = this.#state.seq + 1;
        const next = { ...this.#state, seq };
        await inTransaction(this.#db, async (tx) => {
          for (const { id, vector } of batch) {
            await tx.query(
              `INSERT INTO ${tail}(id, seq, vec) VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, vec = excluded.vec`,
              [id, seq, float32Bytes(vector)],
            );
            await tx.query(
              `INSERT INTO ${ids}(id, gen) VALUES (?, 0) ON CONFLICT(id) DO UPDATE SET gen = 0`,
              [id],
            );
          }
          await this.#saveState(tx, next);
        });
        this.#state = next;
        for (const { id, vector } of batch) this.#tail.set(id, { seq, vector });
      });
    }
  }

  async delete(ids: number[]): Promise<void> {
    this.#assertReady();
    ids.forEach(assertId);
    await this.#exclusive(async () => {
      for (let i = 0; i < ids.length; i += VALIDATE_BATCH) {
        const chunk = ids.slice(i, i + VALIDATE_BATCH);
        const json = JSON.stringify(chunk);
        await inTransaction(this.#db, async (tx) => {
          await tx.query(
            `DELETE FROM ${this.#t.tail} WHERE id IN (SELECT value FROM json_each(?))`,
            [json],
          );
          await tx.query(
            `DELETE FROM ${this.#t.ids} WHERE id IN (SELECT value FROM json_each(?))`,
            [json],
          );
        });
        for (const id of chunk) this.#tail.delete(id);
      }
    });
  }

  // ------------------------------------------------------------ search

  async search(query: ArrayLike<number>, opts: SearchOptions = {}): Promise<SearchHit[]> {
    this.#assertReady();
    const k = opts.k ?? 10;
    const nprobe = opts.nprobe ?? 8;
    const perList = k * (opts.oversample ?? 8);
    const q = prepare(query, this.dims, this.metric);
    const d = this.dims;
    const filter = opts.filter;

    // Tail: exact, from memory.
    const tailTop = new TopK<number>(k);
    for (const [id, { vector }] of this.#tail) {
      if (filter && !filter(id)) continue;
      tailTop.push(distance(this.metric, q, 0, vector, 0, d), id);
    }

    const segments = this.#segments;
    for (const s of segments) this.#refs.set(s, (this.#refs.get(s) ?? 0) + 1);
    try {
      // Stage 1: probe lists, keep the best rows of each by estimated residual distance.
      type Hit = Candidate & { seg: SegmentIndex; data: ListData };
      const hits: Hit[] = [];
      // Tail ids are never live in a segment; skip them early.
      const keep = (id: number) => !this.#tail.has(id) && (!filter || filter(id));
      await Promise.all(
        segments.map(async (seg) => {
          const lists = seg.probe(q, nprobe);
          const datas = await this.#store.lists(seg, lists);
          opts.signal?.throwIfAborted();
          lists.forEach((c, i) => {
            const data = datas[i] as ListData;
            for (const cand of seg.filterList(q, c, data, perList, keep)) hits.push({ ...cand, seg, data });
          });
        }),
      );

      // Liveness: a segment row counts only if its generation holds the live copy.
      const live = await this.#generations(hits.map((h) => h.id));

      // Stage 2: int8 re-rank.
      const rerank = opts.exact ? k * 4 : k;
      const segTop = new TopK<Hit>(rerank);
      for (const h of hits) {
        if (live.get(h.id) !== h.seg.gen) continue;
        segTop.push(h.seg.scoreInt8(q, h.data, h.row), h);
      }
      let segResults = segTop.sorted().map((e) => ({ id: e.item.id, distance: e.score, hit: e.item }));

      // Stage 3: exact re-rank from stored floats.
      if (opts.exact) {
        segResults = await Promise.all(
          segResults.map(async (r) => {
            const all = await this.#store.floats(r.hit.seg, r.hit.list);
            const v = all.subarray(r.hit.row * d, (r.hit.row + 1) * d);
            return { ...r, distance: distance(this.metric, q, 0, v, 0, d) };
          }),
        );
      }

      const final = new TopK<number>(k);
      for (const r of segResults) final.push(r.distance, r.id);
      for (const e of tailTop.sorted()) final.push(e.score, e.item);
      return final.sorted().map((e) => ({ id: e.item, distance: e.score }));
    } finally {
      for (const s of segments) this.#refs.set(s, (this.#refs.get(s) ?? 1) - 1);
      void this.#reap().catch(() => {}); // a failed reap leaves rows that init() sweeps
    }
  }

  /** The stored vectors of the live `ids` (normalised for cosine); unknown or deleted ids are absent. */
  async getVectors(ids: number[]): Promise<Map<number, Float32Array>> {
    this.#assertReady();
    ids.forEach(assertId);
    const out = new Map<number, Float32Array>();
    const gens = await this.#generations(ids);
    const wanted = new Map<number, Set<number>>(); // gen -> ids
    for (const [id, gen] of gens) {
      if (gen === 0) {
        const entry = this.#tail.get(id);
        if (entry) out.set(id, entry.vector.slice());
        continue;
      }
      let set = wanted.get(gen);
      if (!set) wanted.set(gen, (set = new Set()));
      set.add(id);
    }
    for (const seg of this.#segments) {
      const set = wanted.get(seg.gen);
      if (!set) continue;
      for (let c = 0; c < seg.nlist && set.size > 0; c++) {
        if (seg.counts[c] === 0) continue;
        const [data] = (await this.#store.lists(seg, [c])) as [ListData];
        let floats: Float32Array | null = null;
        for (let r = 0; r < data.ids.length; r++) {
          const id = data.ids[r] as number;
          if (!set.has(id)) continue;
          floats ??= await this.#store.floats(seg, c);
          out.set(id, floats.slice(r * this.dims, (r + 1) * this.dims));
          set.delete(id);
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ maintenance

  /** Seals the current tail into a new segment. Returns the number of vectors sealed. */
  async compact(): Promise<number> {
    this.#assertReady();
    return this.#maintenance(async () => {
      const snapshot = await this.#exclusive(async () => ({
        maxSeq: this.#state.seq,
        entries: [...this.#tail.entries()],
      }));
      if (snapshot.entries.length === 0) return 0;

      const n = snapshot.entries.length;
      const ids = new Float64Array(n);
      const vectors = new Float32Array(n * this.dims);
      snapshot.entries.forEach(([id, e], i) => {
        ids[i] = id;
        vectors.set(e.vector, i * this.dims);
      });
      const built = this.#build(ids, vectors);

      await this.#exclusive(async () => {
        const ref = this.#refOf(built, n);
        const next: State = {
          ...this.#state,
          nextGen: ref.gen + 1,
          segments: [...this.#state.segments, ref],
        };
        const { ids: idsT, tail } = this.#t;
        await inTransaction(this.#db, async (tx) => {
          await this.#store.write(tx, ref.gen, built);
          await tx.query(
            `UPDATE ${idsT} SET gen = ? WHERE gen = 0
             AND id IN (SELECT id FROM ${tail} WHERE seq <= ?)`,
            [ref.gen, snapshot.maxSeq],
          );
          await tx.query(`DELETE FROM ${tail} WHERE seq <= ?`, [snapshot.maxSeq]);
          await this.#saveState(tx, next);
        });
        this.#state = next;
        for (const [id, e] of this.#tail) if (e.seq <= snapshot.maxSeq) this.#tail.delete(id);
        this.#segments = [...this.#segments, this.#segmentOf(ref, built)];
      });
      return n;
    });
  }

  /**
   * Rewrites all segments into one (retraining the IVF lists) and drops dead
   * rows. Holds all live segment vectors in memory while it runs.
   */
  async merge(): Promise<number> {
    this.#assertReady();
    return this.#maintenance(async () => {
      const old = this.#segments;
      if (old.length === 0) return 0;
      const oldGens = old.map((s) => s.gen);

      const idList: number[] = [];
      const chunks: Float32Array[] = [];
      for (const seg of old) {
        for (let c = 0; c < seg.nlist; c++) {
          if (seg.counts[c] === 0) continue;
          const [data] = (await this.#store.lists(seg, [c])) as [ListData];
          const floats = await this.#store.floats(seg, c);
          const live = await this.#generations(Array.from(data.ids));
          for (let r = 0; r < data.ids.length; r++) {
            const id = data.ids[r];
            if (live.get(id) !== seg.gen) continue;
            idList.push(id);
            chunks.push(floats.subarray(r * this.dims, (r + 1) * this.dims));
          }
        }
      }

      const n = idList.length;
      const vectors = new Float32Array(n * this.dims);
      chunks.forEach((v, i) => vectors.set(v, i * this.dims));
      const built = n > 0 ? this.#build(Float64Array.from(idList), vectors) : null;

      await this.#exclusive(async () => {
        const ref = built ? this.#refOf(built, n) : null;
        const kept = this.#state.segments.filter((s) => !oldGens.includes(s.gen));
        const next: State = {
          ...this.#state,
          nextGen: ref ? ref.gen + 1 : this.#state.nextGen,
          segments: ref ? [...kept, ref] : kept,
        };
        await inTransaction(this.#db, async (tx) => {
          if (ref && built) {
            await this.#store.write(tx, ref.gen, built);
            await tx.query(
              `UPDATE ${this.#t.ids} SET gen = ? WHERE gen IN (SELECT value FROM json_each(?))`,
              [ref.gen, JSON.stringify(oldGens)],
            );
          }
          await this.#saveState(tx, next);
        });
        this.#state = next;
        this.#segments = [
          ...this.#segments.filter((s) => !oldGens.includes(s.gen)),
          ...(ref && built ? [this.#segmentOf(ref, built)] : []),
        ];
        this.#retired.push(...old);
      });
      await this.#reap();
      return n;
    });
  }

  /** compact() then merge(). */
  async optimize(): Promise<void> {
    await this.compact();
    await this.merge();
  }

  // ------------------------------------------------------------ private

  #build(ids: Float64Array, vectors: Float32Array): BuiltSegment {
    return buildSegment({
      dims: this.dims,
      metric: this.metric,
      ids,
      vectors,
      nlist: this.#nlist?.(ids.length),
    });
  }

  #refOf(built: BuiltSegment, count: number): SegmentRef {
    return { gen: this.#state.nextGen, count, nlist: built.nlist };
  }

  #segmentOf(ref: SegmentRef, built: BuiltSegment): SegmentIndex {
    return new SegmentIndex(ref.gen, this.dims, this.metric, built.centroids, built.counts);
  }

  async #generations(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += VALIDATE_BATCH) {
      const rows = await this.#db.query<{ id: number; gen: number }>(
        `SELECT id, gen FROM ${this.#t.ids} WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(unique.slice(i, i + VALIDATE_BATCH))],
      );
      for (const r of rows) out.set(Number(r.id), Number(r.gen));
    }
    return out;
  }

  async #saveState(tx: Db, state: State): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.#t.meta}(k, v) VALUES ('state', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      [JSON.stringify(state)],
    );
  }

  /** Deletes the rows of retired segments once no search is reading them. */
  async #reap(): Promise<void> {
    const ready = this.#retired.filter((s) => (this.#refs.get(s) ?? 0) === 0);
    if (ready.length === 0) return;
    this.#retired = this.#retired.filter((s) => !ready.includes(s));
    for (const s of ready) this.#refs.delete(s);
    const gens = ready.map((s) => s.gen);
    await inTransaction(this.#db, (tx) => this.#store.drop(tx, gens));
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #maintenance<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#maintaining) throw new Error("vector-index: compact or merge already running");
    this.#maintaining = true;
    try {
      return await fn();
    } finally {
      this.#maintaining = false;
    }
  }

  #assertReady() {
    if (!this.#ready) throw new Error("vector-index: call init() first");
  }
}

function assertId(id: number) {
  if (!Number.isSafeInteger(id)) throw new Error(`vector-index: id must be a safe integer, got ${id}`);
}

/** Drops every table of the index under `prefix`, in one transaction. Needs no dims or metric. */
export async function dropVectorIndex(db: Db, prefix: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error(`vector-index: bad prefix ${prefix}`);
  await inTransaction(db, async (tx) => {
    for (const t of ["meta", "ids", "tail", "centroids", "seg", "f32"]) {
      await tx.exec(`DROP TABLE IF EXISTS ${prefix}${t}`);
    }
  });
}
```

`packages/db-sqlite-index/src/vector/index.ts`:

```ts
export type { SegmentRef } from "./sql-segment-store.js";
export type { Metric, SearchHit, SearchOptions } from "./types.js";
export {
  dropVectorIndex,
  VectorIndex,
  type VectorIndexOptions,
  type VectorIndexStats,
  type VectorItem,
} from "./vector-index.js";
```

- [ ] **Step 8: Run both suites and make sure they pass**

Run: `pnpm --filter @statewalker/db-sqlite-index exec vitest run src/vector`
Expected: PASS. That is 3 (segment) + 2 × 7 (ported) + 2 × 8 (lifecycle) = 33 tests. The log prints recall lines like `node:sqlite cosine: recall@10 int8=0.9xx exact=0.9xx`.

If "probing every list … equals brute force" fails on one query because of a tie or an int8 rank flip outside the top 40, don't loosen the assertion. Check that `exact` re-ranks `k * 4` and that `oversample: 1e6` really keeps every row. The identity has to hold on this clustered data.

- [ ] **Step 9: Write the README** (package shape; if P3 already created it, add the vector sections and keep its n-gram sections)

`packages/db-sqlite-index/README.md`:

````markdown
# @statewalker/db-sqlite-index

## What it is

Indexes that keep all of their data in SQLite tables through `Db` from
`@statewalker/db-api`, so they run wherever a `Db` runs: Node.js (node:sqlite),
the browser (sqlite-wasm) and Cloudflare-style Durable Objects. The `./vector`
subpath is an IVF vector index for approximate nearest-neighbour search over
integer ids. Ids are the caller's: typically the rowid of its own documents table.

## Why it exists

Durable Objects allow no native extensions, so sqlite-vec and pgvector are not
available there, and their SQLite refuses BLOBs over ~2 MB, more than ~100 bound
parameters, `PRAGMA` and `BEGIN`. This package is pure TypeScript over plain
SQL and stays inside those limits, so one index implementation serves every
runtime. It knows nothing about documents or search ranking. Callers map ids to
their own records.

## How to use

```sh
pnpm add @statewalker/db-sqlite-index @statewalker/db-sqlite
```

Create a `Db` with any SQLite driver whose `Db` supports `inTransaction` from
`@statewalker/db-sqlite` (`@statewalker/db-sqlite-node`,
`@statewalker/db-sqlite-browser`, `@statewalker/db-sqlite-do`), then:

```ts
import { VectorIndex } from "@statewalker/db-sqlite-index/vector";

const index = new VectorIndex({ db, prefix: "vec_", dims: 384, metric: "cosine" });
await index.init();
await index.upsert([{ id: 1, vector: embedding }]);
const hits = await index.search(query, { k: 10 }); // [{ id, distance }], lower is closer
```

## Examples

```ts
// Filter while searching (applied before re-ranking, so k results still come back).
const mine = await index.search(query, { k: 10, filter: (id) => allowed.has(id) });

// Exact re-rank from stored float32 vectors: slower, closer to brute force.
const precise = await index.search(query, { k: 10, nprobe: 16, exact: true });

// Deletes and overwrites are immediate; segment copies are hidden, not rewritten.
await index.delete([1, 2, 3]);

// Seal the tail into a segment, then rewrite all segments into one.
await index.compact();
await index.merge();

// Read stored vectors back (normalised for cosine), and drop the whole index.
const vectors = await index.getVectors([1, 2]); // Map<id, Float32Array>
await dropVectorIndex(db, "vec_");
```

Every write method runs its own `inTransaction`. Never call one from inside an
`inTransaction(db, …)` callback: the index holds the outer `Db`, so on Node.js
and in the browser the inner call waits for the outer transaction to finish,
which never happens — the callback hangs with no error.

## Internals

### The index is an LSM: an exact tail, then immutable segments

New vectors go to `{p}tail` and are mirrored in memory, where search is exact.
`compact()` seals the tail into an immutable IVF segment in one transaction.
`{p}ids(id, gen)` records which generation holds the live copy of each id
(0 = tail). A segment hit counts only when its generation matches, so deletes
and overwrites never rewrite segment rows. `merge()` rebuilds all segments into
one and drops dead rows.

### Search narrows candidates three times

1. Probe the `nprobe` lists whose centroids are closest to the query.
2. A 1-bit filter keeps `k × oversample` rows per list. It estimates the real
   metric from the signs of each vector's residual to its centroid, plus the
   residual's norm and its projection on the centroid (RaBitQ-style). This makes
   it accurate for `dot` and `l2` too, not only `cosine`.
3. Re-rank the survivors with int8 codes. With `exact: true`, re-rank the top
   `4k` again with the stored float32 vectors.

A segment below 2048 vectors is one flat list: k-means would not pay off.

### Storage stays inside Durable Object limits

| Table | Holds |
|---|---|
| `{p}meta` | `config` (dims, metric) and `state` (sequence, segment list) |
| `{p}ids` | live generation per id |
| `{p}tail` | tail vectors |
| `{p}centroids` | one row per segment list: centroid and row count |
| `{p}seg` | each list's searchable block (ids, sign bits, norms, int8 codes), in parts |
| `{p}f32` | each list's float32 block, in parts |

Every BLOB is split into parts of at most 1 MiB, and id lists travel as one
`json_each(?)` parameter. Durable Object SQLite would otherwise refuse with
"string or blob too big" or "too many SQL variables". A probe reads the needed
lists of a segment in one query. Read blocks go into an LRU cache
(`cacheBytes`, default 64 MiB), which never goes stale because a generation is
never modified.

### Constraints

- **One writer per database.** Use one Durable Object, one worker or one tab.
  Within an instance, writes are serialised. Another writer's changes become
  visible after `refresh()`.
- **`merge()` holds every live segment vector in memory** while it runs.
- **Opening existing tables with different `dims` or `metric` fails** with
  `vector-index: tables were created with {"dims":…,"metric":…}, not …`.
- **Retired segment rows are deleted once no search reads them.** If the process
  stops before that, the next `init()` sweeps them.

### Dependencies

`@statewalker/db-api` (the `Db` type) and `@statewalker/db-sqlite`
(`inTransaction`, which runs every write as one transaction on each runtime).
The vector math, k-means and segment codec have no dependencies.

## License

MIT
````

- [ ] **Step 10: Typecheck, lint, test, commit**

```bash
pnpm --filter @statewalker/db-sqlite-index typecheck
pnpm biome check --write --unsafe packages/db-sqlite-index
pnpm --filter @statewalker/db-sqlite-index test
git add packages/db-sqlite-index
git commit -m "feat(db-sqlite-index): VectorIndex over Db with SQL-row segments, ported 0.1.0 suite"
```

Expected: all three commands exit 0, with 29 tests passing.

---

### Task 3: Auto-compaction sized for the celld deadline

**Files:**
- Modify: `packages/db-sqlite-index/src/vector/vector-index.ts` (options, constructor, `upsert`)
- Modify: `packages/db-sqlite-index/src/vector/vector-index.test.ts` (`setup` turns auto-compaction off, because those cases assert explicit `compact()` counts)
- Modify: `packages/db-sqlite-index/README.md`
- Test: `packages/db-sqlite-index/src/vector/auto-compact.test.ts`

**Interfaces:**
- Consumes: `VectorIndex` from Task 2.
- Produces: `VectorIndexOptions.autoCompactAt?: number`. The default is 4096; `Infinity` turns it off.

- [ ] **Step 1: Write the failing test**

`packages/db-sqlite-index/src/vector/auto-compact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BACKENDS, D, dataset, recall } from "./test-fixtures.js";
import { VectorIndex } from "./vector-index.js";

for (const [name, open] of Object.entries(BACKENDS)) {
  describe(`auto-compaction over ${name}`, { timeout: 60_000 }, () => {
    it("compacts once the tail reaches 4096 vectors by default", async () => {
      const db = await open();
      const index = new VectorIndex({ db, prefix: "vec_", dims: D });
      await index.init();
      const items = dataset(4500, 21);
      await index.upsert(items);
      // Batches of 200: the tail reaches 4200 >= 4096 after 21 batches, then 300 more arrive.
      expect(index.stats.segments.map((s) => s.count)).toEqual([4200]);
      expect(index.stats.tail).toBe(300);
      expect(await recall(index, items, "cosine", { nprobe: 16 })).toBeGreaterThanOrEqual(0.85);
    });

    it("never compacts on its own when autoCompactAt is Infinity", async () => {
      const db = await open();
      const index = new VectorIndex({ db, prefix: "vec_", dims: D, autoCompactAt: Infinity });
      await index.init();
      await index.upsert(dataset(4500, 22));
      expect(index.stats.segments).toEqual([]);
      expect(index.stats.tail).toBe(4500);
    });
  });
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @statewalker/db-sqlite-index exec vitest run src/vector/auto-compact.test.ts`
Expected: FAIL. The first case gets `[]` instead of `[4200]`; the second is a type error / unknown option `autoCompactAt` under typecheck.

- [ ] **Step 3: Implement**

In `vector-index.ts`, add to `VectorIndexOptions`:

```ts
  /**
   * upsert() seals the tail into a segment once it holds this many vectors.
   * Default 4096: compacting a larger tail risks the 15 s operation deadline of
   * a Durable Object on celld. Infinity turns it off.
   */
  autoCompactAt?: number;
```

Add a field and set it in the constructor:

```ts
  readonly #autoCompactAt: number;
  // in the constructor:
  this.#autoCompactAt = opts.autoCompactAt ?? 4096;
```

In `upsert`, after each batch's `await this.#exclusive(...)` and still inside the `for` loop, add:

```ts
      if (this.#tail.size >= this.#autoCompactAt && !this.#maintaining) await this.compact();
```

`compact()` takes `#exclusive` itself, so it must run outside the batch's `#exclusive` call. Placed here, it does.

In `vector-index.test.ts`, change `setup` so the ported cases keep asserting explicit `compact()` counts:

```ts
      const index = new VectorIndex({ db, prefix: "vec_", dims: D, metric, autoCompactAt: Infinity });
```

- [ ] **Step 4: Run every vector suite**

Run: `pnpm --filter @statewalker/db-sqlite-index exec vitest run src/vector`
Expected: PASS, 29 + 4 = 33 tests.

- [ ] **Step 5: Document the failure mode in the README**

In `README.md`, add this subsection under `## Internals`, after "Search narrows candidates three times":

```markdown
### upsert() compacts at 4096 vectors, because a Durable Object operation has 15 s

Compaction trains k-means and writes the whole segment in one transaction. On
celld every Durable Object operation has a 15 s deadline, and compacting a much
larger tail can exceed it. So `upsert()` compacts as soon as the tail holds
`autoCompactAt` vectors (default 4096). If the deadline is hit anyway (very high
`dims`, a slow host), the symptom is a timeout and a retried request, not an
error from this package: the transaction rolls back and the tail is intact.
Lower `autoCompactAt` in that case. Set it to `Infinity` to compact only when
you call `compact()`.
```

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm --filter @statewalker/db-sqlite-index typecheck
pnpm biome check --write --unsafe packages/db-sqlite-index
git add packages/db-sqlite-index
git commit -m "feat(db-sqlite-index): auto-compact the vector tail at 4096 (celld 15 s deadline)"
```

---

### Task 4: The benchmark and the changeset

**Files:**
- Create: `packages/db-sqlite-index/bench/vector-bench.ts`
- Create: `.changeset/db-sqlite-index-vector.md`

**Interfaces:**
- Consumes: `VectorIndex` (Tasks 2–3), `mulberry32`, `distance` and `prepare` (Task 1), `newNodeSqliteDb` (P1).
- Produces: `pnpm --filter @statewalker/db-sqlite-index bench`.

- [ ] **Step 1: Write the bench (a port of 0.1.0 `tests/bench.ts`, plus the 4096-tail compaction time that the auto-compact threshold relies on)**

`packages/db-sqlite-index/bench/vector-bench.ts`:

```ts
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { VectorIndex } from "../src/vector/index.js";
import { mulberry32 } from "../src/vector/kmeans.js";
import { distance, prepare } from "../src/vector/math.js";

const N = Number(process.argv[2] ?? 50_000);
const D = Number(process.argv[3] ?? 384);
const r = mulberry32(1);
const centers = Array.from({ length: 200 }, () => Float32Array.from({ length: D }, () => r() * 2 - 1));
const items = Array.from({ length: N }, (_, i) => {
  const c = centers[Math.floor(r() * 200)] as Float32Array;
  return { id: i + 1, vector: Float32Array.from(c, (x) => x + (r() - 0.5) * 0.8) };
});

const db = await newNodeSqliteDb();
const index = new VectorIndex({ db, prefix: "vec_", dims: D, autoCompactAt: Number.POSITIVE_INFINITY });
await index.init();

let t = performance.now();
await index.upsert(items);
console.log(`upsert ${N}: ${(performance.now() - t).toFixed(0)} ms`);
t = performance.now();
await index.compact();
console.log(`compact ${N}: ${(performance.now() - t).toFixed(0)} ms`);

const [size] = await db.query<{ bytes: number }>(
  `SELECT (SELECT coalesce(sum(length(bytes)), 0) FROM vec_seg)
        + (SELECT coalesce(sum(length(bytes)), 0) FROM vec_f32)
        + (SELECT coalesce(sum(length(centroid)), 0) FROM vec_centroids) AS bytes`,
);
const bytes = Number(size?.bytes);
console.log(
  `segment: ${(bytes / 1e6).toFixed(1)} MB = ${(bytes / N).toFixed(0)} B/vector (float32 alone: ${4 * D})`,
);

const norm = items.map((it) => prepare(it.vector, D, "cosine"));
for (const exact of [false, true]) {
  let hit = 0;
  let ms = 0;
  const rq = mulberry32(9);
  for (let i = 0; i < 50; i++) {
    const base = items[Math.floor(rq() * N)] as (typeof items)[number];
    const q = prepare(base.vector.map((x) => x + (rq() - 0.5) * 0.3), D, "cosine");
    const truth = new Set(
      norm
        .map((v, j) => ({ j, d: distance("cosine", q, 0, v, 0, D) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 10)
        .map((x) => x.j + 1),
    );
    const t0 = performance.now();
    const got = await index.search(q, { k: 10, nprobe: 16, exact });
    ms += performance.now() - t0;
    hit += got.filter((h) => truth.has(h.id)).length;
  }
  console.log(
    `search exact=${exact}: recall@10 ${(hit / 500).toFixed(3)}, ${(ms / 50).toFixed(2)} ms/query (warm cache)`,
  );
}

// The auto-compact threshold must keep one compaction well under celld's 15 s deadline.
const tail = new VectorIndex({ db, prefix: "tail_", dims: D, autoCompactAt: Number.POSITIVE_INFINITY });
await tail.init();
await tail.upsert(items.slice(0, 4096));
t = performance.now();
await tail.compact();
console.log(`compact 4096 (auto-compact threshold): ${(performance.now() - t).toFixed(0)} ms`);
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @statewalker/db-sqlite-index bench`
Expected: six lines (upsert, compact, segment, search exact=false, search exact=true, compact 4096). `search exact=false` should show recall@10 ≥ 0.85, and `compact 4096` should be far below 15000 ms.

Record the numbers in the commit message. If `compact 4096` takes more than about 5000 ms, stop and report it: the 4096 default would then be unsafe on celld.

- [ ] **Step 3: Add the changeset**

`.changeset/db-sqlite-index-vector.md`:

```markdown
---
"@statewalker/db-sqlite-index": minor
---

New package. `./vector`: an IVF vector index (1-bit residual filter, int8 re-rank, float32 re-rank) whose tail and segments are SQLite rows behind `Db`, so it runs on node:sqlite, sqlite-wasm and Durable Objects. Writes go through `inTransaction`; BLOBs stay under 1 MiB per row; the tail auto-compacts at 4096 vectors.
```

- [ ] **Step 4: Full checks and commit**

```bash
pnpm --filter @statewalker/db-sqlite-index test
pnpm --filter @statewalker/db-sqlite-index typecheck
pnpm --filter @statewalker/db-sqlite-index build && ls packages/db-sqlite-index/dist
pnpm biome check --write --unsafe packages/db-sqlite-index .changeset
git add packages/db-sqlite-index .changeset/db-sqlite-index-vector.md
git commit -m "chore(db-sqlite-index): vector bench (50k x 384) and changeset"
```

Expected: tests and typecheck pass. `dist` contains `vector.mjs` and `vector.d.mts`, plus the ngram files if P3 has landed.

---

### Task 5: Vector smoke scenario on a real celld (`test:do`)

**Files:**
- Create: `packages/db-sqlite-index/src/vector/do-smoke.ts`
- Modify: `packages/db-sqlite-do/test-do/scenarios.ts` (P1 Task 4)

**Interfaces:**
- Consumes: `VectorIndex` (Tasks 2–3); P1's `test-do/scenarios.ts` `SCENARIOS` list of `{ name: string; run(db: Db): Promise<void> }`.
- Produces: `vectorDoScenarios` (not exported from the package; imported by relative path only).

The fake already enforces the parameter and BLOB limits; this checks the same paths on the real platform, where the 15 s deadline also applies.

- [ ] **Step 1: Write the scenario**

`packages/db-sqlite-index/src/vector/do-smoke.ts`:

```ts
import type { Db } from "@statewalker/db-api";
import { VectorIndex } from "./vector-index.js";

const check = (ok: boolean, message: string) => {
  if (!ok) throw new Error(`vector smoke: ${message}`);
};

/** Run inside a real Durable Object by db-sqlite-do's `pnpm test:do`. */
export const vectorDoScenarios = [
  {
    name: "vector: multi-part segment rows, 150 ids in one delete, read-back",
    async run(db: Db) {
      const dims = 256;
      const n = 1100; // flat list; float block 4 × 1100 × 256 ≈ 1.1 MB → 2 parts
      const index = new VectorIndex({ db, prefix: "smoke_", dims, autoCompactAt: Number.POSITIVE_INFINITY });
      await index.init();
      const vector = (i: number) => Float32Array.from({ length: dims }, (_, j) => Math.sin(i * 7 + j));
      await index.upsert(Array.from({ length: n }, (_, i) => ({ id: i + 1, vector: vector(i + 1) })));
      check((await index.compact()) === n, "compact sealed every vector");
      const [parts] = await db.query<{ n: number }>("SELECT count(*) AS n FROM smoke_f32");
      check(Number(parts?.n) >= 2, `expected ≥ 2 float parts, got ${parts?.n}`);
      const gone = Array.from({ length: 150 }, (_, i) => i + 1);
      await index.delete(gone);
      const hit = await index.search(vector(500), { k: 1, exact: true });
      check(hit[0]?.id === 500, `nearest of 500 is ${hit[0]?.id}`);
      const back = await index.getVectors([1, 500]);
      check(!back.has(1) && back.has(500), "getVectors returns only live ids");
    },
  },
];
```

- [ ] **Step 2: Register it**

In `packages/db-sqlite-do/test-do/scenarios.ts`, add the import and spread it into `SCENARIOS` (keep any other spread already there, e.g. P3's `ngramDoScenarios`):

```ts
import { vectorDoScenarios } from "../../db-sqlite-index/src/vector/do-smoke.js";

export const SCENARIOS = [...sqliteTransactionScenarios, ...vectorDoScenarios];
```

- [ ] **Step 3: Run it on celld**

Run: `pnpm test:do`
Expected: the new case `vector: multi-part segment rows, 150 ids in one delete, read-back` passes with the others. A `string or blob too big` or `too many SQL variables` here means a code path binds more than the fake caught: fix the engine, not the scenario.

- [ ] **Step 4: Commit**

```bash
pnpm biome check --write --unsafe packages/db-sqlite-index/src/vector/do-smoke.ts packages/db-sqlite-do/test-do/scenarios.ts
git add packages/db-sqlite-index/src/vector/do-smoke.ts packages/db-sqlite-do/test-do/scenarios.ts
git commit -m "test(db-sqlite-index): vector smoke scenario on a real celld DO"
```

---

## Self-review

**Spec coverage:**

| Spec item | Where it is covered |
|---|---|
| D8: the package lives in statewalker-db, depends on db-api + db-sqlite, `./vector` subpath, core imports nothing from db-* | Task 1 (package.json, purity grep) |
| D11: the 0.1.0 API kept | Task 2 (`init`, `refresh`, `stats`, `upsert`, `delete`, `search` + filter/signal, `compact`, `merge`, `optimize`) |
| D11: the six named tables | Task 2 |
| D11: parts ≤ ~1.5 MB | `PART_BYTES` = 1 MiB, tested |
| D11: tail mirrored in memory | Task 2 |
| D11: auto-compact at ~4k | Task 3, with the failure mode in the README |
| D11: explicit in-memory merge | Task 2 |
| D11: flat below ~2k | `MIN_TRAIN = 2048`, tested in Task 1 |
| D11: metrics cosine, dot, l2 | Task 2 |
| D14: lifecycle, probe-all = brute force, recall | Task 2 |
| D14: all 7 chat cases over the Db drivers | Task 2, node:sqlite + fake DO |
| D14: `pnpm bench` | Task 4 |
| D14: DO tested both ways | fake DO in every suite (Tasks 2–3); real celld smoke scenario (Task 5) |
| P5 needs: `getVectors`, `idTable`, `dropVectorIndex` | Task 2, tested in the lifecycle suite |

**Deliberately not in this plan:**
- **Tiered merge, sliced compaction, iterative probing, the hypvector upgrades:** deferred in the spec.
- **The FilesApi segment store:** D7, deferred.
- **A sqlite-wasm backend in the suites:** the engine uses only `Db`, and P1's conformance and transaction suites cover sqlite-wasm. Adding the wasm cold start to every vector run buys nothing the Db suites don't already prove.

**Placeholders:** none. Every code step has the full code. `math.ts` and `kmeans.ts` are copied verbatim by an exact command from the durable archive in the notes drive.

**Type consistency, checked across tasks:**
- `BuiltSegment.{nlist, counts, centroids, lists, floats}` is used by `SqlSegmentStore.write`, `#refOf` and `#segmentOf`.
- `SegmentIndex(gen, dims, metric, centroids, counts)` is constructed the same way in the codec test, in `open` and in `#segmentOf`.
- `SqlSegmentStore.lists(seg, cs): Promise<ListData[]>` and `floats(seg, c): Promise<Float32Array>` match their uses in search and merge.
- `SegmentRef {gen, count, nlist}` is used in state, stats and `open`.
- `getVectors`, `idTable` and `dropVectorIndex` (Task 2) are the exact names P5 consumes.
- `autoCompactAt` appears only in Task 3 and later, and in the Task 3 edit of the Task 2 test setup.

**Review Focus:** all five lines have a test in Task 2: parts, search during merge, 150 ids, invalid input, empty / k > n.
