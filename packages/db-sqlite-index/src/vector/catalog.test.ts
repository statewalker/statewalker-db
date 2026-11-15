import type { Db } from "@statewalker/db-api";
import { describe, expect, it } from "vitest";
import { dropCatalog, GenerationCatalog } from "./catalog.js";
import { buildSegment } from "./segment.js";
import { SqlSegmentStore } from "./sql-segment-store.js";
import { BACKENDS } from "./test-fixtures.js";

// The catalog's invariants at its own interface: a commit and the copy move together, a reopened
// catalog reads back what was committed, sweep and drop cover every table. Segments are tiny
// (flat, no k-means).
const D = 4;
const P = "c_";
const CONFIG = JSON.stringify({ dims: D, metric: "l2" });

const vec = (x: number) => Float32Array.from({ length: D }, (_, i) => x + i);
const built = (ids: number[]) =>
  buildSegment({
    dims: D,
    metric: "l2",
    ids: Float64Array.from(ids),
    vectors: Float32Array.from(ids.flatMap((id) => [...vec(id)])),
  });

for (const [name, open] of Object.entries(BACKENDS)) {
  describe(`GenerationCatalog over ${name}`, () => {
    async function catalogOn(db: Db) {
      const catalog = new GenerationCatalog(db, P, new SqlSegmentStore(db, P, D));
      await catalog.create(CONFIG);
      catalog.adopt(await catalog.read());
      return catalog;
    }

    /** What a fresh catalog on the same storage reads back. */
    async function stored(db: Db) {
      const snapshot = await (await catalogOn(db)).read();
      return { state: snapshot.state, tail: [...snapshot.tail.keys()].sort((a, b) => a - b) };
    }

    const copyOf = (c: GenerationCatalog) => ({
      state: c.state,
      tail: [...c.tail.keys()].sort((a, b) => a - b),
    });

    async function tables(db: Db) {
      const rows = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'c\\_%' ESCAPE '\\'`,
      );
      return rows.map((r) => r.name).sort();
    }

    it("starts empty and refuses tables made with another config", async () => {
      const db = await open();
      const catalog = await catalogOn(db);
      expect(copyOf(catalog)).toEqual({ state: { seq: 0, nextGen: 1, segments: [] }, tail: [] });
      expect(catalog.idTable).toBe("c_ids");
      const other = new GenerationCatalog(db, P, new SqlSegmentStore(db, P, 8));
      await expect(other.create(JSON.stringify({ dims: 8, metric: "l2" }))).rejects.toThrow(
        /tables were created with/,
      );
    });

    it("every commit leaves the copy equal to what a reopen reads", async () => {
      const db = await open();
      const catalog = await catalogOn(db);

      await catalog.append([1, 2, 3].map((id) => ({ id, vector: vec(id) })));
      expect(copyOf(catalog)).toEqual(await stored(db));
      expect(catalog.state.seq).toBe(1);

      await catalog.append([4].map((id) => ({ id, vector: vec(id) })));
      await catalog.remove([2]);
      expect(copyOf(catalog)).toEqual(await stored(db));
      expect(copyOf(catalog).tail).toEqual([1, 3, 4]);

      // Seal batch 1 only: batch 2 (id 4) stays in the tail.
      let installed: unknown = null;
      const ref = await catalog.seal(1, built([1, 3]), 2, (r) => {
        installed = r;
        expect(catalog.state.segments).toContainEqual(r); // the copy is already updated
      });
      expect(installed).toEqual(ref);
      expect(ref).toEqual({ gen: 1, count: 2, nlist: 1 });
      expect(copyOf(catalog)).toEqual(await stored(db));
      expect(copyOf(catalog).tail).toEqual([4]);
      expect(await catalog.generations([1, 2, 3, 4])).toEqual(
        new Map([
          [1, 1],
          [3, 1],
          [4, 0],
        ]),
      );

      await catalog.seal(2, built([4]), 1, () => {});
      const merged = await catalog.replace([1, 2], built([1, 3, 4]), 3, () => {});
      expect(merged).toEqual({ gen: 3, count: 3, nlist: 1 });
      expect(copyOf(catalog)).toEqual(await stored(db));
      expect(catalog.state).toEqual({ seq: 2, nextGen: 4, segments: [merged] });
      expect([...(await catalog.generations([1, 3, 4])).values()]).toEqual([3, 3, 3]);

      // Replacing with nothing drops the generations from the state and keeps nextGen.
      await catalog.remove([1, 3, 4]);
      expect(await catalog.replace([3], null, 0, () => {})).toBeNull();
      expect(catalog.state).toEqual({ seq: 2, nextGen: 4, segments: [] });
      expect(copyOf(catalog)).toEqual(await stored(db));
    });

    it("a failed commit changes neither storage nor the copy", async () => {
      const db = await open();
      const catalog = await catalogOn(db);
      await catalog.append([{ id: 1, vector: vec(1) }]);
      await catalog.seal(1, built([1]), 1, () => {});
      const before = copyOf(catalog);
      // A catalog that never read the state still thinks nextGen is 1: writing generation 1's
      // rows again violates the store's primary key inside the transaction.
      const stale = new GenerationCatalog(db, P, new SqlSegmentStore(db, P, D));
      let installed = false;
      await expect(
        stale.seal(1, built([2]), 1, () => {
          installed = true;
        }),
      ).rejects.toThrow();
      expect(installed).toBe(false);
      expect(copyOf(stale)).toEqual({ state: { seq: 0, nextGen: 1, segments: [] }, tail: [] });
      expect(await stored(db)).toEqual(before);
      expect(await catalog.generations([1])).toEqual(new Map([[1, 1]]));
    });

    it("sweep deletes segment rows of generations the state does not list", async () => {
      const db = await open();
      const catalog = await catalogOn(db);
      await catalog.append([1, 2].map((id) => ({ id, vector: vec(id) })));
      await catalog.seal(1, built([1, 2]), 2, () => {});
      // Rows of a generation that never committed, as a crash mid-maintenance leaves them.
      await db.query(
        `INSERT INTO c_centroids(gen, list, count, centroid) VALUES (9, 0, 0, x'00000000')`,
      );
      await db.query(`INSERT INTO c_seg(gen, list, part, bytes) VALUES (9, 0, 0, x'00')`);
      await catalog.sweep();
      for (const t of ["c_centroids", "c_seg", "c_f32"]) {
        const gens = await db.query<{ gen: number }>(`SELECT DISTINCT gen FROM ${t}`);
        expect(gens.map((g) => Number(g.gen))).toEqual([1]);
      }
      await catalog.dropGenerations([1]);
      for (const t of ["c_centroids", "c_seg", "c_f32"]) {
        expect(await db.query(`SELECT gen FROM ${t}`)).toEqual([]);
      }
    });

    it("dropCatalog drops every table under the prefix, and only those", async () => {
      const db = await open();
      await catalogOn(db);
      await db.exec(`CREATE TABLE other_t(x)`);
      expect(await tables(db)).toEqual([
        "c_centroids",
        "c_f32",
        "c_ids",
        "c_meta",
        "c_seg",
        "c_tail",
      ]);
      await dropCatalog(db, P);
      expect(await tables(db)).toEqual([]);
      expect(
        (await db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE name = 'other_t'`))
          .length,
      ).toBe(1);
    });
  });
}
