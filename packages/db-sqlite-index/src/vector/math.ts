import type { Metric } from "./types.js";

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Float32Array(v.length);
  if (n === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Vectors are stored pre-normalized for cosine, so cosine reduces to dot. */
export function prepare(v: ArrayLike<number>, dims: number, metric: Metric): Float32Array {
  if (v.length !== dims) throw new Error(`vector-index: expected ${dims} dims, got ${v.length}`);
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  for (let i = 0; i < f.length; i++) {
    if (!Number.isFinite(f[i])) throw new Error("vector-index: vector contains a non-finite value");
  }
  return metric === "cosine" ? normalize(f) : f.slice();
}

/** Distance between two float vectors at offsets; lower is closer. */
export function distance(
  metric: Metric,
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
  d: number,
): number {
  if (metric === "l2") {
    let s = 0;
    for (let i = 0; i < d; i++) {
      const x = a[ao + i] - b[bo + i];
      s += x * x;
    }
    return s;
  }
  let s = 0;
  for (let i = 0; i < d; i++) s += a[ao + i] * b[bo + i];
  return metric === "cosine" ? 1 - s : -s;
}

// ------------------------------------------------------------ int8

/** Symmetric per-vector int8: x ≈ q * scale / 127. Returns the scale. */
export function quantizeInt8(v: Float32Array, vo: number, d: number, out: Int8Array, oo: number) {
  let max = 0;
  for (let i = 0; i < d; i++) max = Math.max(max, Math.abs(v[vo + i]));
  const inv = max === 0 ? 0 : 127 / max;
  for (let i = 0; i < d; i++) out[oo + i] = Math.round(v[vo + i] * inv);
  return max;
}

/** Distance between a float query and an int8-coded vector. */
export function distanceInt8(
  metric: Metric,
  q: Float32Array,
  codes: Int8Array,
  co: number,
  scale: number,
  d: number,
): number {
  const f = scale / 127;
  if (metric === "l2") {
    let s = 0;
    for (let i = 0; i < d; i++) {
      const x = q[i] - codes[co + i] * f;
      s += x * x;
    }
    return s;
  }
  let s = 0;
  for (let i = 0; i < d; i++) s += q[i] * codes[co + i];
  s *= f;
  return metric === "cosine" ? 1 - s : -s;
}

export function dequantizeInt8(codes: Int8Array, co: number, scale: number, d: number) {
  const out = new Float32Array(d);
  const f = scale / 127;
  for (let i = 0; i < d; i++) out[i] = codes[co + i] * f;
  return out;
}

// ------------------------------------------------------------ 1-bit

export const wordsFor = (d: number) => (d + 31) >>> 5;

/** Sign bits of (v - centroid): residual binarization, meaningful for every metric. */
export function residualBits(
  v: Float32Array,
  vo: number,
  c: Float32Array,
  co: number,
  d: number,
  out: Uint32Array,
  oo: number,
) {
  const w = wordsFor(d);
  out.fill(0, oo, oo + w);
  for (let i = 0; i < d; i++) {
    if (v[vo + i] > c[co + i]) out[oo + (i >>> 5)] |= 1 << (i & 31);
  }
}

export function hamming(a: Uint32Array, b: Uint32Array, bo: number, w: number): number {
  let n = 0;
  for (let i = 0; i < w; i++) {
    let x = a[i] ^ b[bo + i];
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    n += Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }
  return n;
}

// ------------------------------------------------------------ top-k

/** Keeps the `k` smallest scores. A binary max-heap over parallel arrays. */
export class TopK<T> {
  readonly #k: number;
  readonly #scores: number[] = [];
  readonly #items: T[] = [];

  constructor(k: number) {
    this.#k = Math.max(0, k);
  }

  get size() {
    return this.#scores.length;
  }

  /** The score a new item must beat, or Infinity while not full. */
  get bound() {
    return this.#scores.length < this.#k ? Number.POSITIVE_INFINITY : this.#scores[0];
  }

  push(score: number, item: T) {
    if (this.#k === 0) return;
    const s = this.#scores;
    const it = this.#items;
    if (s.length < this.#k) {
      s.push(score);
      it.push(item);
      let i = s.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (s[p] >= s[i]) break;
        this.#swap(i, p);
        i = p;
      }
      return;
    }
    if (score >= s[0]) return;
    s[0] = score;
    it[0] = item;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < s.length && s[l] > s[m]) m = l;
      if (r < s.length && s[r] > s[m]) m = r;
      if (m === i) break;
      this.#swap(i, m);
      i = m;
    }
  }

  /** Ascending by score. */
  sorted(): { score: number; item: T }[] {
    return this.#scores
      .map((score, i) => ({ score, item: this.#items[i] }))
      .sort((a, b) => a.score - b.score);
  }

  #swap(i: number, j: number) {
    const s = this.#scores;
    const it = this.#items;
    [s[i], s[j]] = [s[j], s[i]];
    [it[i], it[j]] = [it[j], it[i]];
  }
}
