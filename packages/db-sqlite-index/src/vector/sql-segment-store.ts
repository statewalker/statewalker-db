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
      throw new Error(
        `vector-index: segment ${ref.gen} has ${rows.length} lists, expected ${ref.nlist}`,
      );
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
      await tx.query(`DELETE FROM ${table} WHERE gen NOT IN (SELECT value FROM json_each(?))`, [
        json,
      ]);
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
