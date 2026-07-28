import { describe, expect, it } from "vitest";

/**
 * Node-safe smoke test. The real browser coverage (shared conformance suite +
 * FTS/VSS) lives in `browser-duckdb.browser.test.ts`, run via Vitest browser
 * mode (`pnpm test:browser`); this file only checks the module loads and
 * exports its factory, since duckdb-wasm needs a browser Worker to run.
 */
describe("browser-duckdb module", () => {
  it("exports newBrowserDuckDb function", async () => {
    const mod = await import("./browser-duckdb.js");
    expect(typeof mod.newBrowserDuckDb).toBe("function");
  });
});
