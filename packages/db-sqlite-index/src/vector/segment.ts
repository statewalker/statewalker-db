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
      const est = l2 ? qn * qn + data.rnorm[r] * data.rnorm[r] - 2 * rr : -(qc + data.cdot[r] + rr);
      if (est < top.bound) top.push(est, { list: c, row: r, id });
    }
    return top.sorted().map((e) => e.item);
  }

  /** Stage 2: approximate distance from the int8 codes. */
  scoreInt8(query: Float32Array, data: ListData, row: number): number {
    return distanceInt8(
      this.metric,
      query,
      data.codes,
      row * this.dims,
      data.scales[row],
      this.dims,
    );
  }
}
