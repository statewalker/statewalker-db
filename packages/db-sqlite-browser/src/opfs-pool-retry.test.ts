import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Records the engines the driver starts, so a test can make the OPFS pool install fail, then work.
const engines: Sqlite3Static[] = [];
vi.mock("@sqlite.org/sqlite-wasm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sqlite.org/sqlite-wasm")>();
  const init = actual.default as (...args: unknown[]) => Promise<Sqlite3Static>;
  return {
    ...actual,
    default: async (...args: unknown[]) => {
      const sqlite3 = await init(...args);
      engines.push(sqlite3);
      return sqlite3;
    },
  };
});

const { newBrowserSqliteDb } = await import("./browser-sqlite-db.js");

const scope = globalThis as { DedicatedWorkerGlobalScope?: unknown };

describe("newBrowserSqliteDb recovers from a failed start", () => {
  beforeAll(() => {
    scope.DedicatedWorkerGlobalScope = class {};
  });
  afterAll(() => {
    delete scope.DedicatedWorkerGlobalScope;
  });

  it("retries the OPFS pool install after it failed (another worker held the pool)", async () => {
    // Start the engine (in memory) to get hold of it.
    await (await newBrowserSqliteDb()).close();
    const sqlite3 = engines.at(-1) as Sqlite3Static;

    const calls: unknown[] = [];
    sqlite3.installOpfsSAHPoolVfs = (async (options: unknown) => {
      calls.push(options);
      if (calls.length === 1) throw new Error("OPFS lock: held by another worker");
      class OpfsSAHPoolDb extends sqlite3.oo1.DB {
        constructor(_path: string) {
          super(":memory:", "c");
        }
      }
      return { OpfsSAHPoolDb, reserveMinimumCapacity: async () => 0 };
    }) as unknown as Sqlite3Static["installOpfsSAHPoolVfs"];

    await expect(newBrowserSqliteDb({ path: "/a.db" })).rejects.toThrow(/OPFS lock/);
    const db = await newBrowserSqliteDb({ path: "/a.db" });
    try {
      expect(await db.query("SELECT 1 AS x")).toEqual([{ x: 1 }]);
    } finally {
      await db.close();
    }
    expect(calls).toHaveLength(2);
    // sqlite-wasm caches a failed install too, unless asked to try again.
    expect(calls[1]).toMatchObject({ forceReinitIfPreviouslyFailed: true });
  });

  it("retries loading the engine from a wasmUrl that failed before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-wasm-"));
    try {
      const wasmUrl = join(dir, "sqlite3.wasm");
      await expect(newBrowserSqliteDb({ wasmUrl })).rejects.toThrow();
      copyFileSync(
        createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"),
        wasmUrl,
      );
      const db = await newBrowserSqliteDb({ wasmUrl });
      try {
        expect(await db.query("SELECT 2 AS y")).toEqual([{ y: 2 }]);
      } finally {
        await db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
