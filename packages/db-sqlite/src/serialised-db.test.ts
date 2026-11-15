import { describe, expect, it } from "vitest";
import { newSerialisedDb, type SerialisedDbEngine } from "./serialised-db.js";

/** An engine whose calls settle only when the test says so, logging what runs when. */
function newManualEngine(rows: Record<string, unknown>[] = []) {
  const log: string[] = [];
  const pending: (() => void)[] = [];
  const later = (entry: string) =>
    new Promise<void>((resolve) => {
      log.push(`start ${entry}`);
      pending.push(() => {
        log.push(`end ${entry}`);
        resolve();
      });
    });
  const engine: SerialisedDbEngine = {
    query: async (sql) => {
      await later(sql);
      return rows.map((row) => ({ ...row }));
    },
    exec: (sql) => later(sql),
    close: () => later("close"),
  };
  const settleNext = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.shift()?.();
  };
  return { engine, log, settleNext };
}

describe("newSerialisedDb", () => {
  it("starts each call once the previous one has settled, close last", async () => {
    const { engine, log, settleNext } = newManualEngine();
    const db = newSerialisedDb(engine, { name: "db-x" });
    const all = Promise.all([db.exec("a"), db.query("b"), db.close()]);
    for (let i = 0; i < 3; i++) await settleNext();
    await all;
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start close", "end close"]);
  });

  it("rejects calls made once close has started with '<name>: the database is closed'", async () => {
    const { engine, settleNext } = newManualEngine();
    const db = newSerialisedDb(engine, { name: "db-x" });
    const closed = db.close();
    await expect(db.query("SELECT 1")).rejects.toThrow("db-x: the database is closed");
    await expect(db.exec("SELECT 1")).rejects.toThrow("db-x: the database is closed");
    await settleNext();
    await closed;
  });

  it("closes the engine once however often close is called", async () => {
    let closes = 0;
    const db = newSerialisedDb(
      { query: async () => [], exec: async () => {}, close: () => void closes++ },
      { name: "db-x" },
    );
    await Promise.all([db.close(), db.close()]);
    await db.close();
    expect(closes).toBe(1);
  });

  it("keeps running after a call fails", async () => {
    const db = newSerialisedDb(
      {
        query: async (sql) => {
          if (sql === "bad") throw new Error("boom");
          return [{ ok: 1 }];
        },
        exec: async () => {},
        close: () => {},
      },
      { name: "db-x" },
    );
    await expect(db.query("bad")).rejects.toThrow("boom");
    expect(await db.query("good")).toEqual([{ ok: 1 }]);
  });

  it("queues flush when the engine has it, and leaves it out otherwise", async () => {
    const flushed: string[] = [];
    const plain = newSerialisedDb(
      { query: async () => [], exec: async () => {}, close: () => {} },
      { name: "db-x" },
    );
    expect(plain.flush).toBeUndefined();
    const buffered = newSerialisedDb(
      {
        query: async () => [],
        exec: async (sql) => void flushed.push(sql),
        flush: async () => void flushed.push("flush"),
        close: () => {},
      },
      { name: "db-x" },
    );
    await Promise.all([buffered.exec("a"), buffered.flush?.(), buffered.exec("b")]);
    expect(flushed).toEqual(["a", "flush", "b"]);
    await buffered.close();
    await expect(buffered.flush?.()).rejects.toThrow("db-x: the database is closed");
  });

  it("returns safe integers as numbers and larger ones as bigints, nested values too", async () => {
    const big = 2n ** 60n;
    const db = newSerialisedDb(
      {
        query: async () => [
          { a: 5n, b: big, c: [1n, big], d: { e: -3n, f: [{ g: 7n }] }, h: new Uint8Array([1]) },
        ],
        exec: async () => {},
        close: () => {},
      },
      { name: "db-x" },
    );
    expect(await db.query("SELECT")).toEqual([
      { a: 5, b: big, c: [1, big], d: { e: -3, f: [{ g: 7 }] }, h: new Uint8Array([1]) },
    ]);
  });
});
