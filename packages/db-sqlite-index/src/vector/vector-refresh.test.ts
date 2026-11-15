import type { Db } from "@statewalker/db-api";
import { SQLITE_TRANSACTION } from "@statewalker/db-sqlite";
import { describe, expect, it } from "vitest";
import { BACKENDS, D, dataset, type Item } from "./test-fixtures.js";
import { VectorIndex } from "./vector-index.js";

// refresh() racing maintenance and writes (#26). Each race is forced through the public API: the
// operation starts without being awaited, refresh() starts behind it, and refresh's tail read is
// held until the operation has finished. Before the fix refresh() read the state before the
// commit and the tail after it, and installed that mixed snapshot.
for (const [name, open] of Object.entries(BACKENDS)) {
  describe(`VectorIndex.refresh() over ${name}`, { timeout: 60_000 }, () => {
    async function setup() {
      const real = await open();
      const gate = holdTailRead(real);
      const index = new VectorIndex({
        db: gate.db,
        prefix: "vec_",
        dims: D,
        autoCompactAt: Infinity,
      });
      await index.init();
      return { real, gate, index };
    }

    /** Opens a second index on the same storage, as the next process would. */
    async function reopen(real: Db) {
      const index = new VectorIndex({ db: real, prefix: "vec_", dims: D, autoCompactAt: Infinity });
      await index.init();
      return index;
    }

    async function expectAllFound(index: VectorIndex, items: Item[]) {
      const got = await index.getVectors(items.map((it) => it.id));
      expect([...got.keys()].sort((a, b) => a - b)).toEqual(items.map((it) => it.id));
      for (const it of items.slice(0, 10)) {
        expect((await index.search(it.vector, { k: 1, nprobe: 1e6 }))[0]?.id).toBe(it.id);
      }
    }

    it("refresh() during compact() keeps the compacted vectors, also after reopen", async () => {
      const { real, gate, index } = await setup();
      const items = dataset(4, 26);
      await index.upsert(items.slice(0, 3));

      const compacting = index.compact();
      gate.holdUntil(compacting);
      await Promise.all([compacting, index.refresh()]);

      expect(index.stats).toEqual({ tail: 0, segments: [{ gen: 1, count: 3, nlist: 1 }], seq: 1 });
      await expectAllFound(index, items.slice(0, 3));

      // The issue's follow-up: the next upsert and compact work, and a reopened index finds all.
      await index.upsert(items.slice(3));
      expect(await index.compact()).toBe(1);
      await expectAllFound(index, items);
      const reopened = await reopen(real);
      expect(reopened.stats).toEqual(index.stats);
      await expectAllFound(reopened, items);
    });

    // The reproduction of #26 as written: no gate, refresh() a few microtasks after compact().
    for (const ticks of [0, 1, 2, 3, 4, 6]) {
      it(`refresh() ${ticks} microtasks into compact() loses nothing`, async () => {
        const real = await open();
        const index = new VectorIndex({ db: real, prefix: "v_", dims: 8, autoCompactAt: Infinity });
        await index.init();
        const items = dataset(4, 27, 8);
        await index.upsert(items.slice(0, 3));
        const compacting = index.compact();
        for (let i = 0; i < ticks; i++) await null;
        await Promise.all([compacting, index.refresh()]);
        expect(index.stats.segments.length).toBe(1);
        expect(index.stats.tail).toBe(0);
        expect((await index.search(items[1]?.vector as Float32Array, { k: 3 })).length).toBe(3);

        await index.upsert(items.slice(3));
        expect(await index.compact()).toBe(1);
        const reopened = new VectorIndex({ db: real, prefix: "v_", dims: 8 });
        await reopened.init();
        const got = await reopened.getVectors([1, 2, 3, 4]);
        expect([...got.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      });
    }

    it("refresh() during merge() keeps the merged vectors, also after reopen", async () => {
      const { real, gate, index } = await setup();
      const items = dataset(400, 28);
      await index.upsert(items.slice(0, 200));
      await index.compact();
      await index.upsert(items.slice(200));
      await index.compact();

      const merging = index.merge();
      gate.holdUntil(merging);
      const [merged] = await Promise.all([merging, index.refresh()]);
      expect(merged).toBe(400);

      expect(index.stats).toEqual({
        tail: 0,
        segments: [{ gen: 3, count: 400, nlist: 1 }],
        seq: 2,
      });
      await expectAllFound(index, items);

      // A write after the race persists the right state: a reopened index still finds everything.
      const extra = dataset(401, 29)
        .slice(400)
        .map((it) => ({ ...it, id: 401 }));
      await index.upsert(extra);
      await expectAllFound(index, [...items, ...extra]);
      const reopened = await reopen(real);
      expect(reopened.stats).toEqual(index.stats);
      await expectAllFound(reopened, [...items, ...extra]);
    });

    it("refresh() during upsert() sees the upsert whole", async () => {
      const { real, gate, index } = await setup();
      const items = dataset(20, 30);
      await index.upsert(items.slice(0, 10));

      const upserting = index.upsert(items.slice(10));
      gate.holdUntil(upserting);
      await Promise.all([upserting, index.refresh()]);

      expect(index.stats).toEqual({ tail: 20, segments: [], seq: 2 });
      await expectAllFound(index, items);

      expect(await index.compact()).toBe(20);
      expect(index.stats.tail).toBe(0);
      const reopened = await reopen(real);
      expect(reopened.stats).toEqual(index.stats);
      await expectAllFound(reopened, items);
    });

    it("compact() and merge() started while refresh() runs still work", async () => {
      const { real, index } = await setup();
      const items = dataset(300, 31);
      await index.upsert(items.slice(0, 150));
      await index.compact();
      await index.upsert(items.slice(150));

      const refreshing = index.refresh();
      const compacting = index.compact();
      await Promise.all([refreshing, compacting]);
      expect(await compacting).toBe(150);
      const refreshing2 = index.refresh();
      const merging = index.merge();
      await Promise.all([refreshing2, merging]);
      expect(await merging).toBe(300);

      await expectAllFound(index, items);
      const reopened = await reopen(real);
      expect(reopened.stats).toEqual(index.stats);
      await expectAllFound(reopened, items);
    });
  });
}

/**
 * Wraps `real` so that, after `holdUntil(p)`, the next tail read (refresh's `SELECT id, seq, vec`)
 * waits until `p` settles.
 */
function holdTailRead(real: Db) {
  let until: Promise<unknown> | null = null;
  const db = {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (until && sql.includes("SELECT id, seq, vec FROM")) {
        const wait = until;
        until = null;
        await wait.catch(() => {});
      }
      return real.query<T>(sql, params);
    },
    exec: (sql: string) => real.exec(sql),
    close: () => real.close(),
    [SQLITE_TRANSACTION]: (real as { [SQLITE_TRANSACTION]?: unknown })[SQLITE_TRANSACTION],
  } as Db;
  return { db, holdUntil: (p: Promise<unknown>) => (until = p) };
}
