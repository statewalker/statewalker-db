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
    .map((it) => ({
      id: it.id,
      d: distance(metric, qq, 0, prepare(it.vector, dims, metric), 0, dims),
    }))
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
