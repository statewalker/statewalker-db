import { describe, expect, it } from "vitest";

/**
 * Node-safe smoke test. The real browser coverage (shared conformance suite +
 * FTS5/vector) lives in `browser-sqlite-db.browser.test.ts`, run via Vitest
 * browser mode (`pnpm test:browser`); this file only checks the module loads
 * and exports its factory, since libSQL-WASM cannot instantiate under Node.
 */
describe("browser-sqlite-db module", () => {
  it("exports newBrowserSqliteDb function", async () => {
    const mod = await import("./browser-sqlite-db.js");
    expect(typeof mod.newBrowserSqliteDb).toBe("function");
  });
});
