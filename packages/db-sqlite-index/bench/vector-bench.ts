import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { VectorIndex } from "../src/vector/index.js";
import { mulberry32 } from "../src/vector/kmeans.js";
import { distance, prepare } from "../src/vector/math.js";

const N = Number(process.argv[2] ?? 50_000);
const D = Number(process.argv[3] ?? 384);
const r = mulberry32(1);
const centers = Array.from({ length: 200 }, () =>
  Float32Array.from({ length: D }, () => r() * 2 - 1),
);
const items = Array.from({ length: N }, (_, i) => {
  const c = centers[Math.floor(r() * 200)] as Float32Array;
  return { id: i + 1, vector: Float32Array.from(c, (x) => x + (r() - 0.5) * 0.8) };
});

const db = await newNodeSqliteDb();
const index = new VectorIndex({
  db,
  prefix: "vec_",
  dims: D,
  autoCompactAt: Number.POSITIVE_INFINITY,
});
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
    const q = prepare(
      base.vector.map((x) => x + (rq() - 0.5) * 0.3),
      D,
      "cosine",
    );
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
const tail = new VectorIndex({
  db,
  prefix: "tail_",
  dims: D,
  autoCompactAt: Number.POSITIVE_INFINITY,
});
await tail.init();
await tail.upsert(items.slice(0, 4096));
t = performance.now();
await tail.compact();
console.log(`compact 4096 (auto-compact threshold): ${(performance.now() - t).toFixed(0)} ms`);
