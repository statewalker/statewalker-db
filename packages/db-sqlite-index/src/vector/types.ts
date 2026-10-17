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
