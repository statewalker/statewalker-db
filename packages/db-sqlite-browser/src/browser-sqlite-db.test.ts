import { createRequire } from "node:module";
import { runDbConformance, runSqliteTransactionConformance } from "@statewalker/db-tests";
import { describe, expect, it } from "vitest";
import { newBrowserSqliteDb } from "./browser-sqlite-db.js";

// The same WASM engine as in the browser, in memory: the shared suites run under Node too.
runDbConformance(() => newBrowserSqliteDb(), { placeholder: "?", skipFilePersistence: true });
runSqliteTransactionConformance(() => newBrowserSqliteDb());

describe("newBrowserSqliteDb under Node", () => {
  it("rejects a persistent path outside a Dedicated Worker", async () => {
    await expect(newBrowserSqliteDb({ path: "/data.db" })).rejects.toThrow(/Dedicated Worker/);
  });

  it("honors a different wasmUrl after an earlier call", async () => {
    await expect(newBrowserSqliteDb({ wasmUrl: "/nonexistent/sqlite3.wasm" })).rejects.toThrow();
    const wasmPath = createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
    const db = await newBrowserSqliteDb({ wasmUrl: wasmPath });
    try {
      expect(await db.query("SELECT 1 AS x")).toEqual([{ x: 1 }]);
    } finally {
      await db.close();
    }
  });
});
