import { distance, normalize } from "./math.js";
import type { Metric } from "./types.js";

export interface KMeansOptions {
  iterations?: number;
  /** Training points drawn from the data. Default min(n, 32 * k, 25_000). */
  sampleSize?: number;
  seed?: number;
}

/** Small deterministic PRNG so segment builds are reproducible. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Index of the closest centroid. */
export function nearest(
  metric: Metric,
  data: Float32Array,
  offset: number,
  centroids: Float32Array,
  k: number,
  d: number,
): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  // Centroids are compared with l2 for l2, and with dot otherwise (spherical k-means).
  const m: Metric = metric === "l2" ? "l2" : "dot";
  for (let c = 0; c < k; c++) {
    const dist = distance(m, data, offset, centroids, c * d, d);
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  return best;
}

/**
 * k-means++ seeding plus Lloyd iterations on a sample. `data` is n × d, flat.
 * For cosine and dot, centroids are re-normalized (spherical k-means).
 */
export function kmeans(
  data: Float32Array,
  n: number,
  d: number,
  k: number,
  metric: Metric,
  opts: KMeansOptions = {},
): Float32Array {
  const rand = mulberry32(opts.seed ?? 42);
  k = Math.max(1, Math.min(k, n));
  const sampleSize = Math.min(n, opts.sampleSize ?? Math.min(32 * k, 25_000));

  // Reservoir-free sample: a partial Fisher–Yates over indices.
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = 0; i < sampleSize; i++) {
    const j = i + Math.floor(rand() * (n - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const sample = new Float32Array(sampleSize * d);
  for (let i = 0; i < sampleSize; i++) sample.set(data.subarray(idx[i] * d, idx[i] * d + d), i * d);

  const spherical = metric !== "l2";
  const centroids = new Float32Array(k * d);

  // k-means++ with squared l2 on the sample.
  centroids.set(sample.subarray(0, d), 0);
  const minD = new Float64Array(sampleSize).fill(Number.POSITIVE_INFINITY);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < sampleSize; i++) {
      const dd = distance("l2", sample, i * d, centroids, (c - 1) * d, d);
      if (dd < minD[i]) minD[i] = dd;
      total += minD[i];
    }
    let r = rand() * total;
    let pick = sampleSize - 1;
    for (let i = 0; i < sampleSize; i++) {
      r -= minD[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.set(sample.subarray(pick * d, pick * d + d), c * d);
  }

  const assign = new Uint32Array(sampleSize);
  const counts = new Uint32Array(k);
  const iterations = opts.iterations ?? 10;
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let i = 0; i < sampleSize; i++) {
      const c = nearest(metric, sample, i * d, centroids, k, d);
      if (c !== assign[i] || it === 0) moved++;
      assign[i] = c;
    }
    const sums = new Float64Array(k * d);
    counts.fill(0);
    for (let i = 0; i < sampleSize; i++) {
      const c = assign[i];
      counts[c]++;
      for (let j = 0; j < d; j++) sums[c * d + j] += sample[i * d + j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        // Re-seed an empty cluster with a random sample point.
        const p = Math.floor(rand() * sampleSize);
        centroids.set(sample.subarray(p * d, p * d + d), c * d);
        continue;
      }
      for (let j = 0; j < d; j++) centroids[c * d + j] = sums[c * d + j] / counts[c];
    }
    if (spherical) {
      for (let c = 0; c < k; c++) {
        centroids.set(normalize(centroids.subarray(c * d, c * d + d)), c * d);
      }
    }
    if (it > 0 && moved === 0) break;
  }
  return centroids;
}
