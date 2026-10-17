# @statewalker/db-sqlite-index

## What it is

Indexes that keep all of their data in SQLite tables through `Db` from
`@statewalker/db-api`, so they run wherever a `Db` runs: Node.js (node:sqlite),
the browser (sqlite-wasm) and Cloudflare-style Durable Objects. The `./vector`
subpath is an IVF vector index for approximate nearest-neighbour search over
integer ids. The `./ngram` subpath finds every stored text that contains a
literal or matches a JavaScript regex, using a trigram index to pick candidates
and the real regex to confirm them. Ids are the caller's: typically the rowid of
its own documents table.

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
import { dropVectorIndex, VectorIndex } from "@statewalker/db-sqlite-index/vector";

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

// `idTable` names a table whose `id` column holds exactly the live ids:
// join it in SQL to count or enumerate what the index contains.
const [{ n }] = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${index.idTable}`);
```

Every write method runs its own `inTransaction`. Never call any engine method
(`upsert`, `delete`, `compact`, `merge`, `search`, `getVectors`, `getTexts`) from inside an
`inTransaction(db, …)` callback: the index holds the outer `Db`, so on Node.js
and in the browser the inner call waits for the outer transaction to finish,
which never happens — the callback hangs with no error.

Each engine needs its own prefix: both create `{p}meta`, with different columns, so a
vector index and an n-gram index sharing a prefix break each other.

How much one call commits:

- `upsert()` commits every 200 items and `delete()` every 2,000 ids, each batch as its own
  transaction. A failure part-way leaves the earlier batches committed.
- `compact()` and `merge()` are one transaction each.
- An `upsert()` that reaches `autoCompactAt` runs `compact()` after its batch has committed. If
  that compaction fails, `upsert()` rejects although the items are stored. While an
  auto-compact runs, an explicit `compact()` or `merge()` can reject with an "already running"
  error: call it again afterwards.

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

### upsert() compacts at 4096 vectors, because a Durable Object operation has 15 s

Compaction trains k-means and writes the whole segment in one transaction. On
celld every Durable Object operation has a 15 s deadline, and compacting a much
larger tail can exceed it. So `upsert()` compacts as soon as the tail holds
`autoCompactAt` vectors (default 4096). If the deadline is hit anyway (very high
`dims`, a slow host), the symptom is a timeout and a retried request, not an
error from this package: the transaction rolls back and the tail is intact.
Lower `autoCompactAt` in that case. Set it to `Infinity` to compact only when
you call `compact()`.

### Storage stays inside Durable Object limits

| Table | Holds |
|---|---|
| `{p}meta` | `config` (dims, metric) and `state` (sequence, segment list) |
| `{p}ids` | live generation per id |
| `{p}tail` | tail vectors |
| `{p}centroids` | one row per segment list: centroid and row count |
| `{p}seg` | each list's searchable block (ids, sign bits, norms, int8 codes), in parts |
| `{p}f32` | each list's float32 block, in parts |

Each list's searchable and float32 blocks are split into parts of at most
1 MiB (tail and centroid rows hold one vector, `dims × 4` bytes, and are not
split), and id lists travel as one `json_each(?)` parameter. Durable Object SQLite would otherwise refuse with
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
- **A search or `getVectors` that overlaps a `compact()` or `merge()` commit runs
  again** on the new segments, so it does not judge old segment rows against the
  new liveness. The third attempt stands even if a third commit overlaps it.
- **Retired segment rows are deleted once no search reads them.** If the process
  stops before that, the next `init()` sweeps them.

### Dependencies

`@statewalker/db-api` (the `Db` type) and `@statewalker/db-sqlite`
(`inTransaction`, which runs every write as one transaction on each runtime).
The vector math, k-means and segment codec have no dependencies.

## Why `./ngram` finds what full-text search cannot

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

`upsert` and `delete` are each one transaction, however many items they get: atomic, but
unbounded against a Durable Object's 15 s operation deadline, so keep batches small. As in
the vector section, never call `upsert`, `delete`, `search`, `getTexts` or `drop` from inside an
`inTransaction(db, …)` callback on the same `Db`: the call hangs. Use a prefix of its own,
different from any vector index on the same database.

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

## What will surprise you in `./ngram`

- `search` stops at `limit` hits (default 100) and verifies at most
  `candidateBudget` candidates (default 10,000); either cut sets `truncated: true`.
  A pattern with no three-character literal (`\d+`, `ab`) scans, and the budget
  then counts scanned texts.
- A pattern that matches only the empty string (`^`, `(abc)*$`) finds nothing.
- Patterns longer than 1,000 characters fail with
  `ngram: pattern is N characters, the limit is 1000`. A regex with catastrophic
  backtracking still runs to completion; the cap does not prevent that.
- An invalid regex fails with the engine's `SyntaxError`.
- **Regex mode compiles without the `u` flag**, because the case folding used for the index
  is unsound under `/iu` (U+0390 and U+1FD3 are equal under `/iu`, but `fold` separates them,
  so candidates would be missed). So `.` matches one UTF-16 code unit and can split a surrogate
  pair (`😀` yields two matches of `.`, and a hit can end inside an emoji), and `\u{1F600}` is
  not a code-point escape. `\p{…}` and `\P{…}` would silently mean the literal text, so they
  are rejected with `ngram: \p{…} and \P{…} are not supported in regex mode (patterns compile
  without the u flag)`. Literal mode is not affected.
- `search` with `limit: 0` returns no hits and `truncated: true`.
- A lone surrogate in an upserted text is stored, indexed and returned as U+FFFD
  (`text.toWellFormed()`), so offsets and `getTexts` refer to that replaced text.
- Methods other than `init` fail with SQLite's `no such table` until `init` ran.
- On Durable Objects a single text above about 1.5 MB fails with
  `string or blob too big`; batches are split automatically, single texts are not.

## Internals of `./ngram`

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
