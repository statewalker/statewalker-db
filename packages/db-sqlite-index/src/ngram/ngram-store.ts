import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";
import { type GramBackend, type NgramItem, newFts5Backend } from "./fts5-backend.js";
import { chunkJson } from "./json-chunks.js";
import { planQuery } from "./plan-query.js";
import { newPostingsBackend } from "./postings-backend.js";

export type { NgramItem };
export type NgramMatch = { start: number; end: number };
export type NgramHit = { id: number; matches: NgramMatch[] };
export type NgramSearchOptions = {
  /** Treat `pattern` as a JS regex source; otherwise it is literal text. */
  regex?: boolean;
  /** Default true (grep semantics). */
  caseSensitive?: boolean;
  /** Maximum hits. Default 100. */
  limit?: number;
  /** Maximum candidates verified. Default 10,000. */
  candidateBudget?: number;
  /** Keep only ids for which this returns true (applied before verification). */
  filter?: (id: number) => boolean;
  signal?: AbortSignal;
};
export type NgramSearchResult = {
  /** Ascending id order; every non-empty match, offsets in UTF-16 code units. */
  hits: NgramHit[];
  /** True when the search stopped before checking every candidate (budget or limit). */
  truncated: boolean;
};
export type NgramStoreOptions = { db: Db; prefix: string; store?: "fts5" | "postings" };

const VERIFY_BATCH = 256;

export class NgramStore {
  /** `{prefix}texts`: its `id` column holds exactly the stored ids. Callers may join it in SQL. */
  readonly idTable: string;
  readonly #db: Db;
  readonly #prefix: string;
  readonly #store: "fts5" | "postings";
  readonly #backend: GramBackend;

  constructor({ db, prefix, store = "fts5" }: NgramStoreOptions) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
      throw new Error(`ngram: prefix "${prefix}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
    }
    if (store !== "fts5" && store !== "postings")
      throw new Error(`ngram: unknown store "${store}"`);
    this.#db = db;
    this.#prefix = prefix;
    this.idTable = `${prefix}texts`;
    this.#store = store;
    this.#backend = store === "fts5" ? newFts5Backend(prefix) : newPostingsBackend(prefix);
  }

  async init(): Promise<void> {
    const p = this.#prefix;
    await inTransaction(this.#db, async (tx) => {
      await tx.exec(
        `CREATE TABLE IF NOT EXISTS ${p}meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
      const [row] = await tx.query<{ value: string }>(
        `SELECT value FROM ${p}meta WHERE key = 'store'`,
      );
      if (row && row.value !== this.#store) {
        throw new Error(
          `ngram: index "${p}" was created with store "${row.value}", opened with "${this.#store}"`,
        );
      }
      if (!row)
        await tx.query(`INSERT INTO ${p}meta(key, value) VALUES ('store', ?)`, [this.#store]);
      await tx.exec(
        `CREATE TABLE IF NOT EXISTS ${p}texts(id INTEGER PRIMARY KEY, text TEXT NOT NULL)`,
      );
      await this.#backend.create(tx);
    });
  }

  async upsert(items: NgramItem[]): Promise<void> {
    // The last text per id wins; a repeated id would leave stale grams behind.
    // A lone surrogate would be stored differently from how it was indexed, so a
    // later delete could not replay it: texts are made well-formed first.
    const latest = [
      ...new Map(items.map(({ id, text }) => [id, { id, text: text.toWellFormed() }])).values(),
    ];
    if (latest.length === 0) return;
    await inTransaction(this.#db, async (tx) => {
      await this.#backend.remove(
        tx,
        await this.#load(
          tx,
          latest.map((item) => item.id),
        ),
      );
      for (const chunk of chunkJson(latest.map((item) => [item.id, item.text]))) {
        await tx.query(
          `INSERT OR REPLACE INTO ${this.#prefix}texts(id, text) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`,
          [chunk],
        );
      }
      await this.#backend.add(tx, latest);
    });
  }

  async delete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await inTransaction(this.#db, async (tx) => {
      await this.#backend.remove(tx, await this.#load(tx, ids));
      for (const chunk of chunkJson(ids)) {
        await tx.query(
          `DELETE FROM ${this.#prefix}texts WHERE id IN (SELECT value FROM json_each(?))`,
          [chunk],
        );
      }
    });
  }

  async search(pattern: string, opts: NgramSearchOptions = {}): Promise<NgramSearchResult> {
    const { limit = 100, candidateBudget = 10_000, filter, signal } = opts;
    const plan = planQuery(pattern, {
      regex: opts.regex,
      caseSensitive: opts.caseSensitive ?? true,
    });
    signal?.throwIfAborted();
    if (limit <= 0) return { hits: [], truncated: true };
    const found =
      plan.branches === null
        ? (
            await this.#db.query<{ id: number }>(
              `SELECT id FROM ${this.#prefix}texts ORDER BY id LIMIT ?`,
              [candidateBudget + 1],
            )
          ).map((row) => Number(row.id))
        : await this.#backend.candidates(this.#db, plan.branches, candidateBudget + 1);
    let truncated = found.length > candidateBudget;
    const ids = found.slice(0, candidateBudget).filter((id) => !filter || filter(id));

    const hits: NgramHit[] = [];
    let last: number | undefined;
    verify: for (let i = 0; i < ids.length; i += VERIFY_BATCH) {
      signal?.throwIfAborted();
      for (const { id, text } of await this.#load(this.#db, ids.slice(i, i + VERIFY_BATCH))) {
        last = id;
        const matches: NgramMatch[] = [];
        for (const m of text.matchAll(plan.regex)) {
          if (m[0].length > 0) matches.push({ start: m.index, end: m.index + m[0].length });
        }
        if (matches.length === 0) continue;
        hits.push({ id, matches });
        if (hits.length >= limit) break verify;
      }
    }
    if (hits.length >= limit && last !== ids.at(-1)) truncated = true;
    return { hits, truncated };
  }

  /** The stored original texts of `ids`; unknown ids are absent. */
  async getTexts(ids: number[]): Promise<Map<number, string>> {
    const items = await this.#load(this.#db, ids);
    return new Map(items.map((item) => [item.id, item.text]));
  }

  /** Drops the tables of both stores, so it works without knowing which one created the prefix. */
  async drop(): Promise<void> {
    const p = this.#prefix;
    await inTransaction(this.#db, async (tx) => {
      for (const t of ["ng", "grams", "texts", "meta"])
        await tx.exec(`DROP TABLE IF EXISTS ${p}${t}`);
    });
  }

  /** Stored texts for `ids`, ascending by id; missing ids are skipped. */
  async #load(db: Db, ids: number[]): Promise<NgramItem[]> {
    const out: NgramItem[] = [];
    for (const chunk of chunkJson([...ids].sort((a, b) => a - b))) {
      const rows = await db.query<{ id: number; text: string }>(
        `SELECT id, text FROM ${this.#prefix}texts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        [chunk],
      );
      for (const row of rows) out.push({ id: Number(row.id), text: String(row.text) });
    }
    return out;
  }
}
