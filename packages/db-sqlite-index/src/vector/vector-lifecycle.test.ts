import type { Db } from "@statewalker/db-api";
import { SQLITE_TRANSACTION } from "@statewalker/db-sqlite";
import { describe, expect, it } from "vitest";
import { PART_BYTES } from "./sql-segment-store.js";
import { BACKENDS, bruteForce, D, dataset } from "./test-fixtures.js";
import { dropVectorIndex, VectorIndex } from "./vector-index.js";

for (const [name, open] of Object.entries(BACKENDS)) {
  describe(`VectorIndex lifecycle over ${name}`, { timeout: 60_000 }, () => {
    async function setup(dims = D) {
      const db = await open();
      const index = new VectorIndex({ db, prefix: "vec_", dims });
      await index.init();
      return { db, index };
    }

    it("probing every list with exact re-rank equals brute force", async () => {
      const { index } = await setup();
      const items = dataset(3000, 11);
      await index.upsert(items);
      await index.compact();
      expect(index.stats.segments[0]?.nlist).toBeGreaterThan(1);
      for (const it of items.slice(0, 20)) {
        const q = it.vector.map((x) => x + 0.01);
        const got = await index.search(q, { k: 10, nprobe: 1e6, oversample: 1e6, exact: true });
        expect(got.map((h) => h.id)).toEqual(bruteForce(items, q, 10, "cosine"));
      }
    });

    it("empty index and k > n return what exists", async () => {
      const { index } = await setup();
      const q = dataset(1, 12)[0]?.vector as Float32Array;
      expect(await index.search(q, { k: 10 })).toEqual([]);
      await index.upsert(dataset(5, 12));
      expect((await index.search(q, { k: 10 })).length).toBe(5);
      await index.compact();
      expect((await index.search(q, { k: 10 })).length).toBe(5);
    });

    it("rejects invalid input and writes nothing", async () => {
      const { index } = await setup();
      await expect(index.upsert([{ id: 1, vector: new Float32Array(D + 1) }])).rejects.toThrow(
        /expected 64 dims/,
      );
      const nan = new Float32Array(D);
      nan[3] = Number.NaN;
      await expect(index.upsert([{ id: 1, vector: nan }])).rejects.toThrow(/non-finite/);
      await expect(index.upsert([{ id: 2 ** 53, vector: new Float32Array(D) }])).rejects.toThrow(
        /safe integer/,
      );
      expect(index.stats.tail).toBe(0);
    });

    it("deletes many ids in one call", async () => {
      const { index } = await setup();
      const items = dataset(400, 13);
      await index.upsert(items);
      await index.compact();
      const gone = items.slice(0, 150).map((it) => it.id);
      await index.delete(gone);
      const dead = new Set(gone);
      for (const it of items.slice(0, 10)) {
        const hits = await index.search(it.vector, { k: 20 });
        expect(hits.some((h) => dead.has(h.id))).toBe(false);
      }
    });

    it("splits list blocks into parts no larger than PART_BYTES", async () => {
      const dims = 768;
      const { db, index } = await setup(dims);
      const items = dataset(1500, 14, dims); // flat: one list of ~1.3 MB, floats ~4.6 MB
      await index.upsert(items);
      await index.compact();
      const [seg] = await db.query<{ n: number; max: number }>(
        "SELECT count(*) AS n, max(length(bytes)) AS max FROM vec_seg",
      );
      const [f32] = await db.query<{ n: number; max: number }>(
        "SELECT count(*) AS n, max(length(bytes)) AS max FROM vec_f32",
      );
      expect(Number(seg?.n)).toBeGreaterThanOrEqual(2);
      expect(Number(f32?.n)).toBeGreaterThanOrEqual(5);
      expect(Math.max(Number(seg?.max), Number(f32?.max))).toBeLessThanOrEqual(PART_BYTES);
      for (const it of items.slice(0, 10)) {
        expect((await index.search(it.vector, { k: 1, exact: true }))[0]?.id).toBe(it.id);
      }
    });

    it("getVectors returns live stored vectors from the tail and from segments", async () => {
      const { index } = await setup();
      const items = dataset(300, 16);
      await index.upsert(items.slice(0, 200));
      await index.compact();
      await index.upsert(items.slice(200));
      await index.delete([5]);
      const got = await index.getVectors([1, 5, 250, 9999]);
      expect([...got.keys()].sort((a, b) => a - b)).toEqual([1, 250]);
      for (const id of [1, 250]) {
        const want = items[id - 1]?.vector as Float32Array;
        const norm = Math.hypot(...want);
        const v = got.get(id) as Float32Array;
        for (let j = 0; j < D; j++) expect(v[j]).toBeCloseTo((want[j] as number) / norm, 5);
      }
    });

    it("dropVectorIndex removes every table; the prefix can be reused", async () => {
      const { db, index } = await setup();
      await index.upsert(dataset(50, 17));
      await index.compact();
      await dropVectorIndex(db, "vec_");
      const left = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec\\_%' ESCAPE '\\'",
      );
      expect(left).toEqual([]);
      const fresh = new VectorIndex({ db, prefix: "vec_", dims: D * 2 });
      await fresh.init();
      expect(fresh.stats.tail).toBe(0);
    });

    it("search during merge returns correct hits; retired rows are gone after reopen", async () => {
      const real = await open();
      const gate = holdNextLiveness(real);
      const index = new VectorIndex({ db: gate.db, prefix: "vec_", dims: D });
      await index.init();
      const items = dataset(1200, 15);
      await index.upsert(items.slice(0, 600));
      await index.compact();
      await index.upsert(items.slice(600));
      await index.compact();
      const target = items[700] as (typeof items)[number];
      gate.arm();
      const searching = index.search(target.vector, { k: 1 });
      await gate.held; // the search has read its lists and waits on its liveness read
      expect(await index.merge()).toBe(1200);
      gate.release();
      expect((await searching)[0]?.id).toBe(target.id);

      const reopened = new VectorIndex({ db: real, prefix: "vec_", dims: D });
      await reopened.init();
      const [row] = await real.query<{ n: number }>("SELECT count(DISTINCT gen) AS n FROM vec_seg");
      expect(Number(row?.n)).toBe(1);
      expect((await reopened.search(target.vector, { k: 1 }))[0]?.id).toBe(target.id);
    });
  });
}

/** Wraps `real` so that, once armed, the next liveness read (`SELECT id, gen`) waits for `release()`. */
function holdNextLiveness(real: Db) {
  let armed = false;
  let onHeld = () => {};
  let release = () => {};
  const held = new Promise<void>((r) => {
    onHeld = r;
  });
  const released = new Promise<void>((r) => {
    release = r;
  });
  const db = {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (armed && sql.includes("SELECT id, gen")) {
        armed = false;
        onHeld();
        await released;
      }
      return real.query<T>(sql, params);
    },
    exec: (sql: string) => real.exec(sql),
    close: () => real.close(),
    [SQLITE_TRANSACTION]: (real as { [SQLITE_TRANSACTION]?: unknown })[SQLITE_TRANSACTION],
  } as Db;
  return { db, held, release, arm: () => (armed = true) };
}
