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

## License

MIT
