import { describe, expect, it } from "vitest";
import { mulberry32 } from "./kmeans.js";
import { prepare } from "./math.js";
import { buildSegment, MIN_TRAIN, parseList, SegmentIndex } from "./segment.js";

const D = 32;

function clustered(n: number, seed: number): { ids: Float64Array; vectors: Float32Array } {
  const r = mulberry32(seed);
  const centers = Array.from({ length: 20 }, () =>
    Float32Array.from({ length: D }, () => r() * 2 - 1),
  );
  const vectors = new Float32Array(n * D);
  for (let i = 0; i < n; i++) {
    const c = centers[Math.floor(r() * centers.length)] as Float32Array;
    vectors.set(
      prepare(
        c.map((x) => x + (r() - 0.5) * 0.6),
        D,
        "cosine",
      ),
      i * D,
    );
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
