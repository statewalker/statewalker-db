import { describe, expect, it } from "vitest";
import { BACKENDS, D, dataset, recall } from "./test-fixtures.js";
import type { Metric } from "./types.js";
import { VectorIndex } from "./vector-index.js";

for (const [name, open] of Object.entries(BACKENDS)) {
  describe(`VectorIndex over ${name}`, { timeout: 60_000 }, () => {
    async function setup(metric: Metric = "cosine") {
      const db = await open();
      const index = new VectorIndex({
        db,
        prefix: "vec_",
        dims: D,
        metric,
        autoCompactAt: Infinity,
      });
      await index.init();
      return { db, index };
    }

    it("tail search is exact", async () => {
      const { index } = await setup();
      const items = dataset(300, 1);
      await index.upsert(items);
      expect(await recall(index, items, "cosine")).toBe(1);
    });

    for (const metric of ["cosine", "dot", "l2"] as const) {
      it(`compacted IVF segment has high recall (${metric})`, async () => {
        const { index } = await setup(metric);
        const items = dataset(5000, 2);
        await index.upsert(items);
        expect(await index.compact()).toBe(5000);
        expect(index.stats.tail).toBe(0);
        const approx = await recall(index, items, metric, { nprobe: 12 });
        const exact = await recall(index, items, metric, { nprobe: 12, exact: true });
        console.log(
          `  ${name} ${metric}: recall@10 int8=${approx.toFixed(3)} exact=${exact.toFixed(3)}`,
        );
        expect(approx).toBeGreaterThanOrEqual(0.85);
        expect(exact).toBeGreaterThanOrEqual(approx - 0.01);
      });
    }

    it("deletes and overwrites hide segment copies; merge drops them", async () => {
      const { index, db } = await setup();
      const items = dataset(2000, 3);
      await index.upsert(items);
      await index.compact();

      const target = items[10];
      expect((await index.search(target.vector, { k: 1 }))[0]?.id).toBe(target.id);

      await index.delete([target.id]);
      const after = await index.search(target.vector, { k: 5 });
      expect(after.some((h) => h.id === target.id)).toBe(false);

      // Overwrite id 20 with the vector of id 30: a search for 30's vector finds both.
      await index.upsert([{ id: 20, vector: items[29].vector }]);
      const both = (await index.search(items[29].vector, { k: 2 }))
        .map((h) => h.id)
        .sort((a, b) => a - b);
      expect(both).toEqual([20, 30]);
      // The old copy of id 20 (still in the segment) must not show up for its old vector.
      const old = await index.search(items[19].vector, { k: 3 });
      expect(old.every((h) => h.id !== 20 || h.distance > 1e-4)).toBe(true);

      await index.compact(); // a second segment holds the new id 20
      expect(index.stats.segments.length).toBe(2);
      expect(await index.merge()).toBe(1999);
      expect(index.stats.segments.length).toBe(1);
      const both2 = (await index.search(items[29].vector, { k: 2 }))
        .map((h) => h.id)
        .sort((a, b) => a - b);
      expect(both2).toEqual([20, 30]);
      const [row] = await db.query<{ n: number }>("SELECT count(*) AS n FROM vec_ids");
      expect(Number(row?.n)).toBe(1999);
    });

    it("state survives a reopen", async () => {
      const { index, db } = await setup();
      const items = dataset(1500, 4);
      await index.upsert(items.slice(0, 1200));
      await index.compact();
      await index.upsert(items.slice(1200));
      const reopened = new VectorIndex({ db, prefix: "vec_", dims: D });
      await reopened.init();
      expect(reopened.stats.tail).toBe(300);
      expect(reopened.stats.segments.length).toBe(1);
      expect(await recall(reopened, items, "cosine", { nprobe: 16 })).toBeGreaterThanOrEqual(0.85);
    });

    it("filters and rejects a mismatched configuration", async () => {
      const { index, db } = await setup();
      const items = dataset(1200, 5);
      await index.upsert(items);
      await index.compact();
      const even = await index.search(items[0].vector, { k: 10, filter: (id) => id % 2 === 0 });
      expect(even.length).toBe(10);
      expect(even.every((h) => h.id % 2 === 0)).toBe(true);
      const wrong = new VectorIndex({ db, prefix: "vec_", dims: D + 1 });
      await expect(wrong.init()).rejects.toThrow(/created with/);
    });
  });
}
