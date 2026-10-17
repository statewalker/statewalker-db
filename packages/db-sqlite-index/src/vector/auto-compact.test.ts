import { describe, expect, it } from "vitest";
import { BACKENDS, D, dataset, recall } from "./test-fixtures.js";
import { VectorIndex } from "./vector-index.js";

for (const [name, open] of Object.entries(BACKENDS)) {
  describe(`auto-compaction over ${name}`, { timeout: 60_000 }, () => {
    it("compacts once the tail reaches 4096 vectors by default", async () => {
      const db = await open();
      const index = new VectorIndex({ db, prefix: "vec_", dims: D });
      await index.init();
      const items = dataset(4500, 21);
      await index.upsert(items);
      // Batches of 200: the tail reaches 4200 >= 4096 after 21 batches, then 300 more arrive.
      expect(index.stats.segments.map((s) => s.count)).toEqual([4200]);
      expect(index.stats.tail).toBe(300);
      expect(await recall(index, items, "cosine", { nprobe: 16 })).toBeGreaterThanOrEqual(0.85);
    });

    it("never compacts on its own when autoCompactAt is Infinity", async () => {
      const db = await open();
      const index = new VectorIndex({ db, prefix: "vec_", dims: D, autoCompactAt: Infinity });
      await index.init();
      await index.upsert(dataset(4500, 22));
      expect(index.stats.segments).toEqual([]);
      expect(index.stats.tail).toBe(4500);
    });
  });
}
