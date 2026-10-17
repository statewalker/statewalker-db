import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";
import { distance, prepare, TopK } from "./math.js";
import {
  type BuiltSegment,
  buildSegment,
  type Candidate,
  type ListData,
  SegmentIndex,
} from "./segment.js";
import { type SegmentRef, SqlSegmentStore } from "./sql-segment-store.js";
import {
  float32Bytes,
  type Metric,
  type SearchHit,
  type SearchOptions,
  toFloat32,
} from "./types.js";

export interface VectorIndexOptions {
  db: Db;
  /** Table name prefix, e.g. "vec_". Letters, digits and underscores. */
  prefix: string;
  dims: number;
  metric?: Metric;
  /** IVF lists for a new segment of n vectors. Default ~sqrt(n), flat below 2048. */
  nlist?: (n: number) => number;
  /** Cache budget for list blocks read from SQLite, in bytes. Default 64 MiB. */
  cacheBytes?: number;
}

export interface VectorItem {
  /** A safe integer: typically the rowid of your documents table. */
  id: number;
  vector: ArrayLike<number>;
}

export interface VectorIndexStats {
  tail: number;
  segments: SegmentRef[];
  seq: number;
}

interface State {
  seq: number;
  nextGen: number;
  segments: SegmentRef[];
}

interface TailEntry {
  seq: number;
  vector: Float32Array;
}

/** Ids per lookup (bound as one JSON parameter). */
const VALIDATE_BATCH = 2000;
/** Upserted rows per transaction. */
const WRITE_BATCH = 200;

/**
 * An LSM-style vector index over a `Db`.
 *
 * - The mutable tail lives in `{p}tail`, mirrored in memory and searched exactly.
 * - `compact()` seals the tail into an immutable IVF segment (1-bit residual
 *   filter → int8 re-rank → float32 re-rank on `exact`), written as rows in the
 *   same transaction that moves the ids out of the tail.
 * - `{p}ids(id, gen)` says which generation holds the live copy of each id
 *   (0 = tail). A segment hit counts only if its generation matches, so deletes
 *   and overwrites never touch segment rows. `merge()` rewrites all segments
 *   into one, dropping dead rows.
 *
 * One writer per database is assumed (a Durable Object, a worker, one tab);
 * within an instance, writes are serialized.
 */
export class VectorIndex {
  readonly dims: number;
  readonly metric: Metric;
  /** `{prefix}ids`: its `id` column holds exactly the live ids. Callers may join it in SQL. */
  readonly idTable: string;
  readonly #db: Db;
  readonly #store: SqlSegmentStore;
  readonly #nlist?: (n: number) => number;
  readonly #t: { meta: string; ids: string; tail: string };

  #state: State = { seq: 0, nextGen: 1, segments: [] };
  #tail = new Map<number, TailEntry>();
  #segments: SegmentIndex[] = [];
  #refs = new Map<SegmentIndex, number>();
  #retired: SegmentIndex[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #maintaining = false;
  #ready = false;
  /** Bumped before and after each commit that changes the segment list: odd while one runs. */
  #epoch = 0;

  constructor(opts: VectorIndexOptions) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.prefix)) {
      throw new Error(`vector-index: bad prefix ${opts.prefix}`);
    }
    if (!Number.isInteger(opts.dims) || opts.dims < 1) {
      throw new Error("vector-index: dims must be a positive integer");
    }
    this.dims = opts.dims;
    this.metric = opts.metric ?? "cosine";
    this.#db = opts.db;
    this.#store = new SqlSegmentStore(opts.db, opts.prefix, opts.dims, opts.cacheBytes);
    this.#nlist = opts.nlist;
    const p = opts.prefix;
    this.#t = { meta: `${p}meta`, ids: `${p}ids`, tail: `${p}tail` };
    this.idTable = this.#t.ids;
  }

  // ------------------------------------------------------------ lifecycle

  /** Creates tables if missing, loads state and sweeps rows of crashed maintenance. */
  async init(): Promise<void> {
    const { meta, ids, tail } = this.#t;
    for (const s of [
      `CREATE TABLE IF NOT EXISTS ${meta}(k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${ids}(id INTEGER PRIMARY KEY, gen INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${ids}_gen ON ${ids}(gen)`,
      `CREATE TABLE IF NOT EXISTS ${tail}(id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, vec BLOB NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${tail}_seq ON ${tail}(seq)`,
      ...this.#store.schema(),
    ]) {
      await this.#db.exec(s);
    }

    const config = JSON.stringify({ dims: this.dims, metric: this.metric });
    await this.#db.query(
      `INSERT INTO ${meta}(k, v) VALUES ('config', ?) ON CONFLICT(k) DO NOTHING`,
      [config],
    );
    const [stored] = await this.#db.query<{ v: string }>(
      `SELECT v FROM ${meta} WHERE k = 'config'`,
    );
    if (stored?.v !== config) {
      throw new Error(`vector-index: tables were created with ${stored?.v}, not ${config}`);
    }
    await this.refresh();
    const live = this.#state.segments.map((s) => s.gen);
    await inTransaction(this.#db, (tx) => this.#store.sweep(tx, live));
    this.#ready = true;
  }

  /** Reloads state, tail and segments from storage (e.g. after another writer changed them). */
  async refresh(): Promise<void> {
    const [row] = await this.#db.query<{ v: string }>(
      `SELECT v FROM ${this.#t.meta} WHERE k = 'state'`,
    );
    const state: State = row ? JSON.parse(row.v) : { seq: 0, nextGen: 1, segments: [] };

    const tail = new Map<number, TailEntry>();
    const rows = await this.#db.query<{ id: number; seq: number; vec: Uint8Array }>(
      `SELECT id, seq, vec FROM ${this.#t.tail}`,
    );
    for (const r of rows) tail.set(Number(r.id), { seq: Number(r.seq), vector: toFloat32(r.vec) });

    const known = new Map(this.#segments.map((s) => [s.gen, s]));
    const segments = await Promise.all(
      state.segments.map((s) => known.get(s.gen) ?? this.#store.open(s, this.metric)),
    );
    this.#state = state;
    this.#tail = tail;
    this.#segments = segments;
  }

  get stats(): VectorIndexStats {
    return {
      tail: this.#tail.size,
      segments: this.#state.segments.map((s) => ({ ...s })),
      seq: this.#state.seq,
    };
  }

  // ------------------------------------------------------------ writes

  async upsert(items: VectorItem[]): Promise<void> {
    this.#assertReady();
    const prepared = items.map((it) => {
      assertId(it.id);
      return { id: it.id, vector: prepare(it.vector, this.dims, this.metric) };
    });
    const { tail, ids } = this.#t;
    for (let i = 0; i < prepared.length; i += WRITE_BATCH) {
      const batch = prepared.slice(i, i + WRITE_BATCH);
      await this.#exclusive(async () => {
        const seq = this.#state.seq + 1;
        const next = { ...this.#state, seq };
        await inTransaction(this.#db, async (tx) => {
          for (const { id, vector } of batch) {
            await tx.query(
              `INSERT INTO ${tail}(id, seq, vec) VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, vec = excluded.vec`,
              [id, seq, float32Bytes(vector)],
            );
            await tx.query(
              `INSERT INTO ${ids}(id, gen) VALUES (?, 0) ON CONFLICT(id) DO UPDATE SET gen = 0`,
              [id],
            );
          }
          await this.#saveState(tx, next);
        });
        this.#state = next;
        for (const { id, vector } of batch) this.#tail.set(id, { seq, vector });
      });
    }
  }

  async delete(ids: number[]): Promise<void> {
    this.#assertReady();
    ids.forEach(assertId);
    await this.#exclusive(async () => {
      for (let i = 0; i < ids.length; i += VALIDATE_BATCH) {
        const chunk = ids.slice(i, i + VALIDATE_BATCH);
        const json = JSON.stringify(chunk);
        await inTransaction(this.#db, async (tx) => {
          await tx.query(
            `DELETE FROM ${this.#t.tail} WHERE id IN (SELECT value FROM json_each(?))`,
            [json],
          );
          await tx.query(
            `DELETE FROM ${this.#t.ids} WHERE id IN (SELECT value FROM json_each(?))`,
            [json],
          );
        });
        for (const id of chunk) this.#tail.delete(id);
      }
    });
  }

  // ------------------------------------------------------------ search

  async search(query: ArrayLike<number>, opts: SearchOptions = {}): Promise<SearchHit[]> {
    this.#assertReady();
    const k = opts.k ?? 10;
    const nprobe = opts.nprobe ?? 8;
    const perList = k * (opts.oversample ?? 8);
    const q = prepare(query, this.dims, this.metric);
    const d = this.dims;
    const filter = opts.filter;

    return this.#read(async (segments) => {
      // Tail: exact, from memory.
      const tailTop = new TopK<number>(k);
      for (const [id, { vector }] of this.#tail) {
        if (filter && !filter(id)) continue;
        tailTop.push(distance(this.metric, q, 0, vector, 0, d), id);
      }

      // Stage 1: probe lists, keep the best rows of each by estimated residual distance.
      type Hit = Candidate & { seg: SegmentIndex; data: ListData };
      const hits: Hit[] = [];
      // Tail ids are never live in a segment; skip them early.
      const keep = (id: number) => !this.#tail.has(id) && (!filter || filter(id));
      await Promise.all(
        segments.map(async (seg) => {
          const lists = seg.probe(q, nprobe);
          const datas = await this.#store.lists(seg, lists);
          opts.signal?.throwIfAborted();
          lists.forEach((c, i) => {
            const data = datas[i] as ListData;
            for (const cand of seg.filterList(q, c, data, perList, keep))
              hits.push({ ...cand, seg, data });
          });
        }),
      );

      // Liveness: a segment row counts only if its generation holds the live copy.
      const live = await this.#generations(hits.map((h) => h.id));

      // Stage 2: int8 re-rank.
      const rerank = opts.exact ? k * 4 : k;
      const segTop = new TopK<Hit>(rerank);
      for (const h of hits) {
        if (live.get(h.id) !== h.seg.gen) continue;
        segTop.push(h.seg.scoreInt8(q, h.data, h.row), h);
      }
      let segResults = segTop
        .sorted()
        .map((e) => ({ id: e.item.id, distance: e.score, hit: e.item }));

      // Stage 3: exact re-rank from stored floats.
      if (opts.exact) {
        segResults = await Promise.all(
          segResults.map(async (r) => {
            const all = await this.#store.floats(r.hit.seg, r.hit.list);
            const v = all.subarray(r.hit.row * d, (r.hit.row + 1) * d);
            return { ...r, distance: distance(this.metric, q, 0, v, 0, d) };
          }),
        );
      }

      const final = new TopK<number>(k);
      for (const r of segResults) final.push(r.distance, r.id);
      for (const e of tailTop.sorted()) final.push(e.score, e.item);
      return final.sorted().map((e) => ({ id: e.item, distance: e.score }));
    });
  }

  /** The stored vectors of the live `ids` (normalised for cosine); unknown or deleted ids are absent. */
  async getVectors(ids: number[]): Promise<Map<number, Float32Array>> {
    this.#assertReady();
    ids.forEach(assertId);
    return this.#read(async (segments) => {
      const out = new Map<number, Float32Array>();
      const gens = await this.#generations(ids);
      const wanted = new Map<number, Set<number>>(); // gen -> ids
      for (const [id, gen] of gens) {
        if (gen === 0) {
          const entry = this.#tail.get(id);
          if (entry) out.set(id, entry.vector.slice());
          continue;
        }
        const set = wanted.get(gen) ?? new Set<number>();
        set.add(id);
        wanted.set(gen, set);
      }
      for (const seg of segments) {
        const set = wanted.get(seg.gen);
        if (!set) continue;
        for (let c = 0; c < seg.nlist && set.size > 0; c++) {
          if (seg.counts[c] === 0) continue;
          const [data] = (await this.#store.lists(seg, [c])) as [ListData];
          let floats: Float32Array | null = null;
          for (let r = 0; r < data.ids.length; r++) {
            const id = data.ids[r] as number;
            if (!set.has(id)) continue;
            floats ??= await this.#store.floats(seg, c);
            out.set(id, floats.slice(r * this.dims, (r + 1) * this.dims));
            set.delete(id);
          }
        }
      }
      return out;
    });
  }

  // ------------------------------------------------------------ maintenance

  /** Seals the current tail into a new segment. Returns the number of vectors sealed. */
  async compact(): Promise<number> {
    this.#assertReady();
    return this.#maintenance(async () => {
      const snapshot = await this.#exclusive(async () => ({
        maxSeq: this.#state.seq,
        entries: [...this.#tail.entries()],
      }));
      if (snapshot.entries.length === 0) return 0;

      const n = snapshot.entries.length;
      const ids = new Float64Array(n);
      const vectors = new Float32Array(n * this.dims);
      snapshot.entries.forEach(([id, e], i) => {
        ids[i] = id;
        vectors.set(e.vector, i * this.dims);
      });
      const built = this.#build(ids, vectors);

      await this.#exclusive(() =>
        this.#swapSegments(async () => {
          const ref = this.#refOf(built, n);
          const next: State = {
            ...this.#state,
            nextGen: ref.gen + 1,
            segments: [...this.#state.segments, ref],
          };
          const { ids: idsT, tail } = this.#t;
          await inTransaction(this.#db, async (tx) => {
            await this.#store.write(tx, ref.gen, built);
            await tx.query(
              `UPDATE ${idsT} SET gen = ? WHERE gen = 0
             AND id IN (SELECT id FROM ${tail} WHERE seq <= ?)`,
              [ref.gen, snapshot.maxSeq],
            );
            await tx.query(`DELETE FROM ${tail} WHERE seq <= ?`, [snapshot.maxSeq]);
            await this.#saveState(tx, next);
          });
          this.#state = next;
          for (const [id, e] of this.#tail) if (e.seq <= snapshot.maxSeq) this.#tail.delete(id);
          this.#segments = [...this.#segments, this.#segmentOf(ref, built)];
        }),
      );
      return n;
    });
  }

  /**
   * Rewrites all segments into one (retraining the IVF lists) and drops dead
   * rows. Holds all live segment vectors in memory while it runs.
   */
  async merge(): Promise<number> {
    this.#assertReady();
    return this.#maintenance(async () => {
      const old = this.#segments;
      if (old.length === 0) return 0;
      const oldGens = old.map((s) => s.gen);

      const idList: number[] = [];
      const chunks: Float32Array[] = [];
      for (const seg of old) {
        for (let c = 0; c < seg.nlist; c++) {
          if (seg.counts[c] === 0) continue;
          const [data] = (await this.#store.lists(seg, [c])) as [ListData];
          const floats = await this.#store.floats(seg, c);
          const live = await this.#generations(Array.from(data.ids));
          for (let r = 0; r < data.ids.length; r++) {
            const id = data.ids[r];
            if (live.get(id) !== seg.gen) continue;
            idList.push(id);
            chunks.push(floats.subarray(r * this.dims, (r + 1) * this.dims));
          }
        }
      }

      const n = idList.length;
      const vectors = new Float32Array(n * this.dims);
      chunks.forEach((v, i) => {
        vectors.set(v, i * this.dims);
      });
      const built = n > 0 ? this.#build(Float64Array.from(idList), vectors) : null;

      await this.#exclusive(() =>
        this.#swapSegments(async () => {
          const ref = built ? this.#refOf(built, n) : null;
          const kept = this.#state.segments.filter((s) => !oldGens.includes(s.gen));
          const next: State = {
            ...this.#state,
            nextGen: ref ? ref.gen + 1 : this.#state.nextGen,
            segments: ref ? [...kept, ref] : kept,
          };
          await inTransaction(this.#db, async (tx) => {
            if (ref && built) {
              await this.#store.write(tx, ref.gen, built);
              await tx.query(
                `UPDATE ${this.#t.ids} SET gen = ? WHERE gen IN (SELECT value FROM json_each(?))`,
                [ref.gen, JSON.stringify(oldGens)],
              );
            }
            await this.#saveState(tx, next);
          });
          this.#state = next;
          this.#segments = [
            ...this.#segments.filter((s) => !oldGens.includes(s.gen)),
            ...(ref && built ? [this.#segmentOf(ref, built)] : []),
          ];
          this.#retired.push(...old);
        }),
      );
      await this.#reap();
      return n;
    });
  }

  /** compact() then merge(). */
  async optimize(): Promise<void> {
    await this.compact();
    await this.merge();
  }

  // ------------------------------------------------------------ private

  #build(ids: Float64Array, vectors: Float32Array): BuiltSegment {
    return buildSegment({
      dims: this.dims,
      metric: this.metric,
      ids,
      vectors,
      nlist: this.#nlist?.(ids.length),
    });
  }

  #refOf(built: BuiltSegment, count: number): SegmentRef {
    return { gen: this.#state.nextGen, count, nlist: built.nlist };
  }

  #segmentOf(ref: SegmentRef, built: BuiltSegment): SegmentIndex {
    return new SegmentIndex(ref.gen, this.dims, this.metric, built.centroids, built.counts);
  }

  async #generations(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += VALIDATE_BATCH) {
      const rows = await this.#db.query<{ id: number; gen: number }>(
        `SELECT id, gen FROM ${this.#t.ids} WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(unique.slice(i, i + VALIDATE_BATCH))],
      );
      for (const r of rows) out.set(Number(r.id), Number(r.gen));
    }
    return out;
  }

  async #saveState(tx: Db, state: State): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.#t.meta}(k, v) VALUES ('state', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      [JSON.stringify(state)],
    );
  }

  /** Deletes the rows of retired segments once no search is reading them. */
  async #reap(): Promise<void> {
    const ready = this.#retired.filter((s) => (this.#refs.get(s) ?? 0) === 0);
    if (ready.length === 0) return;
    this.#retired = this.#retired.filter((s) => !ready.includes(s));
    for (const s of ready) this.#refs.delete(s);
    const gens = ready.map((s) => s.gen);
    await inTransaction(this.#db, (tx) => this.#store.drop(tx, gens));
  }

  /**
   * Runs `read` over a snapshot of the segments, held against reaping. A read
   * whose liveness lookup straddles a compact or merge commit may not match its
   * snapshot, so it runs again on the new one; the third attempt stands.
   */
  async #read<T>(read: (segments: SegmentIndex[]) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const epoch = this.#epoch;
      const segments = this.#segments;
      for (const s of segments) this.#refs.set(s, (this.#refs.get(s) ?? 0) + 1);
      try {
        const result = await read(segments);
        if (attempt === 3 || (epoch % 2 === 0 && epoch === this.#epoch)) return result;
      } finally {
        for (const s of segments) this.#refs.set(s, (this.#refs.get(s) ?? 1) - 1);
        void this.#reap().catch(() => {}); // a failed reap leaves rows that init() sweeps
      }
    }
  }

  /** Commits a segment-list change; readers that overlap it retry (see `#read`). */
  async #swapSegments(fn: () => Promise<void>): Promise<void> {
    this.#epoch++;
    try {
      await fn();
    } finally {
      this.#epoch++;
    }
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #maintenance<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#maintaining) throw new Error("vector-index: compact or merge already running");
    this.#maintaining = true;
    try {
      return await fn();
    } finally {
      this.#maintaining = false;
    }
  }

  #assertReady() {
    if (!this.#ready) throw new Error("vector-index: call init() first");
  }
}

function assertId(id: number) {
  if (!Number.isSafeInteger(id))
    throw new Error(`vector-index: id must be a safe integer, got ${id}`);
}

/** Drops every table of the index under `prefix`, in one transaction. Needs no dims or metric. */
export async function dropVectorIndex(db: Db, prefix: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix))
    throw new Error(`vector-index: bad prefix ${prefix}`);
  await inTransaction(db, async (tx) => {
    for (const t of ["meta", "ids", "tail", "centroids", "seg", "f32"]) {
      await tx.exec(`DROP TABLE IF EXISTS ${prefix}${t}`);
    }
  });
}
