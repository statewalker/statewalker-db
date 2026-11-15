import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";
import type { BuiltSegment } from "./segment.js";
import { type SegmentRef, SqlSegmentStore } from "./sql-segment-store.js";
import { float32Bytes, toFloat32 } from "./types.js";

/** The committed state, stored as JSON in `{p}meta` under `state`. */
export interface CatalogState {
  /** The last upsert batch: tail rows carry the seq of the batch that wrote them. */
  readonly seq: number;
  /** The generation the next segment gets. Generation 0 is the tail. */
  readonly nextGen: number;
  /** The live segments, oldest first. */
  readonly segments: readonly SegmentRef[];
}

export interface TailEntry {
  seq: number;
  vector: Float32Array;
}

/** What `read()` found in storage, for `adopt()` to install. */
export interface CatalogSnapshot {
  readonly state: CatalogState;
  readonly tail: Map<number, TailEntry>;
}

/** Ids per statement (bound as one JSON parameter). */
const ID_BATCH = 2000;

const EMPTY: CatalogState = { seq: 0, nextGen: 1, segments: [] };

/**
 * The generation catalog of a vector index: the committed state, the `{p}ids` table (which
 * generation holds the live copy of each id, 0 = the tail), the `{p}tail` rows, and the in-memory
 * copy of the state and the tail.
 *
 * It is the only place that commits a state change, and every commit updates the copy in the
 * same synchronous step as it returns from the transaction, so the copy always matches storage.
 * It also creates, sweeps and drops every table under the prefix, asking the segment store for
 * its own.
 *
 * Callers serialize the commits (one at a time per instance); reads of `state` and `tail` may
 * happen at any time and see either the copy before a commit or the copy after it.
 */
export class GenerationCatalog {
  /** `{p}ids`: its `id` column holds exactly the live ids. */
  readonly idTable: string;
  readonly #db: Db;
  readonly #store: SqlSegmentStore;
  readonly #t: { meta: string; ids: string; tail: string };
  #state: CatalogState = EMPTY;
  #tail = new Map<number, TailEntry>();

  constructor(db: Db, prefix: string, store: SqlSegmentStore) {
    this.#db = db;
    this.#store = store;
    this.#t = catalogTables(prefix);
    this.idTable = this.#t.ids;
  }

  /** The committed state, as of the last commit or `adopt()`. Never mutated: replaced. */
  get state(): CatalogState {
    return this.#state;
  }

  /** The tail rows in memory, by id. */
  get tail(): ReadonlyMap<number, TailEntry> {
    return this.#tail;
  }

  // ------------------------------------------------------------ tables

  /**
   * Creates every table if missing and checks the stored config (dims and metric) is `config`:
   * the first open stores it, later opens must match.
   */
  async create(config: string): Promise<void> {
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
  }

  /** Deletes segment rows of every generation the committed state does not list (crash leftovers). */
  async sweep(): Promise<void> {
    const live = this.#state.segments.map((s) => s.gen);
    await inTransaction(this.#db, (tx) => this.#store.sweep(tx, live));
  }

  /** Deletes the segment rows of retired generations. */
  async dropGenerations(gens: number[]): Promise<void> {
    await inTransaction(this.#db, (tx) => this.#store.drop(tx, gens));
  }

  // ------------------------------------------------------------ reading storage

  /** Reads the committed state and the tail rows, without installing them. */
  async read(): Promise<CatalogSnapshot> {
    const [row] = await this.#db.query<{ v: string }>(
      `SELECT v FROM ${this.#t.meta} WHERE k = 'state'`,
    );
    const state: CatalogState = row ? JSON.parse(row.v) : EMPTY;
    const tail = new Map<number, TailEntry>();
    const rows = await this.#db.query<{ id: number; seq: number; vec: Uint8Array }>(
      `SELECT id, seq, vec FROM ${this.#t.tail}`,
    );
    for (const r of rows) tail.set(Number(r.id), { seq: Number(r.seq), vector: toFloat32(r.vec) });
    return { state, tail };
  }

  /** Installs a snapshot from `read()` as the copy. No commit may run between the two. */
  adopt(snapshot: CatalogSnapshot): void {
    this.#state = snapshot.state;
    this.#tail = snapshot.tail;
  }

  /** The generation holding the live copy of each id; deleted or unknown ids are absent. */
  async generations(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += ID_BATCH) {
      const rows = await this.#db.query<{ id: number; gen: number }>(
        `SELECT id, gen FROM ${this.#t.ids} WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(unique.slice(i, i + ID_BATCH))],
      );
      for (const r of rows) out.set(Number(r.id), Number(r.gen));
    }
    return out;
  }

  // ------------------------------------------------------------ commits

  /** Writes `items` to the tail as one new batch (the next seq), in one transaction. */
  async append(items: { id: number; vector: Float32Array }[]): Promise<void> {
    const { tail, ids } = this.#t;
    const seq = this.#state.seq + 1;
    const next: CatalogState = { ...this.#state, seq };
    await inTransaction(this.#db, async (tx) => {
      for (const { id, vector } of items) {
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
      await this.#save(tx, next);
    });
    this.#state = next;
    for (const { id, vector } of items) this.#tail.set(id, { seq, vector });
  }

  /** Removes `ids` from the tail and from the live ids, one transaction per batch. */
  async remove(ids: number[]): Promise<void> {
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const chunk = ids.slice(i, i + ID_BATCH);
      const json = JSON.stringify(chunk);
      await inTransaction(this.#db, async (tx) => {
        await tx.query(`DELETE FROM ${this.#t.tail} WHERE id IN (SELECT value FROM json_each(?))`, [
          json,
        ]);
        await tx.query(`DELETE FROM ${this.#t.ids} WHERE id IN (SELECT value FROM json_each(?))`, [
          json,
        ]);
      });
      for (const id of chunk) this.#tail.delete(id);
    }
  }

  /**
   * Commits `built` (sealed from the tail rows up to `maxSeq`, `count` vectors) as a new
   * generation: writes its rows, moves those ids to it and deletes those tail rows. Tail rows of
   * later batches stay. `install` runs with the new ref in the same synchronous step as the copy
   * update, for the caller's own in-memory segment list.
   */
  async seal(
    maxSeq: number,
    built: BuiltSegment,
    count: number,
    install: (ref: SegmentRef) => void,
  ): Promise<SegmentRef> {
    const ref = this.#refOf(built, count);
    const next: CatalogState = {
      ...this.#state,
      nextGen: ref.gen + 1,
      segments: [...this.#state.segments, ref],
    };
    const { ids, tail } = this.#t;
    await inTransaction(this.#db, async (tx) => {
      await this.#store.write(tx, ref.gen, built);
      await tx.query(
        `UPDATE ${ids} SET gen = ? WHERE gen = 0
         AND id IN (SELECT id FROM ${tail} WHERE seq <= ?)`,
        [ref.gen, maxSeq],
      );
      await tx.query(`DELETE FROM ${tail} WHERE seq <= ?`, [maxSeq]);
      await this.#save(tx, next);
    });
    this.#state = next;
    for (const [id, e] of this.#tail) if (e.seq <= maxSeq) this.#tail.delete(id);
    install(ref);
    return ref;
  }

  /**
   * Replaces the generations `oldGens` with `built` (`count` live vectors), or with nothing when
   * `built` is null: writes its rows, moves the ids of the old generations to it and drops them
   * from the state. Their rows stay until `dropGenerations()`. `install` runs as in `seal()`.
   */
  async replace(
    oldGens: number[],
    built: BuiltSegment | null,
    count: number,
    install: (ref: SegmentRef | null) => void,
  ): Promise<SegmentRef | null> {
    const ref = built ? this.#refOf(built, count) : null;
    const kept = this.#state.segments.filter((s) => !oldGens.includes(s.gen));
    const next: CatalogState = {
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
      await this.#save(tx, next);
    });
    this.#state = next;
    install(ref);
    return ref;
  }

  #refOf(built: BuiltSegment, count: number): SegmentRef {
    return { gen: this.#state.nextGen, count, nlist: built.nlist };
  }

  async #save(tx: Db, state: CatalogState): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.#t.meta}(k, v) VALUES ('state', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      [JSON.stringify(state)],
    );
  }
}

function catalogTables(prefix: string) {
  return { meta: `${prefix}meta`, ids: `${prefix}ids`, tail: `${prefix}tail` };
}

/** Drops every table under `prefix` (the catalog's and the segment store's), in one transaction. */
export async function dropCatalog(db: Db, prefix: string): Promise<void> {
  const tables = [
    ...Object.values(catalogTables(prefix)),
    ...Object.values(SqlSegmentStore.tables(prefix)),
  ];
  await inTransaction(db, async (tx) => {
    for (const t of tables) await tx.exec(`DROP TABLE IF EXISTS ${t}`);
  });
}
