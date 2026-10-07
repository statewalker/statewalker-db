import { describe, expect, it } from "vitest";
import { newBrowserSqliteDb } from "./browser-sqlite-db.js";

/**
 * Node-side tests. The real browser coverage (shared conformance suite +
 * FTS5/vector) lives in `browser-sqlite-db.browser.test.ts`, run via Vitest
 * browser mode (`pnpm test:browser`). Under Node the engine's loader reads
 * `wasmUrl` as a file path, which is enough to check how the engine is loaded.
 */
const wasmPath = decodeURIComponent(
  new URL(
    "../node_modules/@libsql/libsql-wasm-experimental/sqlite-wasm/jswasm/sqlite3.wasm",
    import.meta.url,
  ).pathname,
);

describe("browser-sqlite-db module", () => {
  it("exports newBrowserSqliteDb function", async () => {
    const mod = await import("./browser-sqlite-db.js");
    expect(typeof mod.newBrowserSqliteDb).toBe("function");
  });

  it("honors a different wasmUrl after an earlier call", async () => {
    await expect(newBrowserSqliteDb({ wasmUrl: "/nonexistent/sqlite3.wasm" })).rejects.toThrow(
      /ENOENT/,
    );
    const db = await newBrowserSqliteDb({ wasmUrl: wasmPath });
    try {
      expect(await db.query("SELECT 1 AS x")).toEqual([{ x: 1 }]);
    } finally {
      await db.close();
    }
  });
});
