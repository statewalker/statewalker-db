import { describe, expect, it } from "vitest";
import { newBrowserDuckDb } from "./browser-duckdb.js";

/**
 * Node-safe tests. The real browser coverage (shared conformance suite +
 * FTS/VSS) lives in `browser-duckdb.browser.test.ts`, run via Vitest browser
 * mode (`pnpm test:browser`); this file only checks what runs before a Worker
 * is needed, since duckdb-wasm needs a browser Worker to run. The start
 * sequence itself is covered with fakes in `start-duckdb.test.ts`.
 */
describe("browser-duckdb module", () => {
  it("exports newBrowserDuckDb function", () => {
    expect(typeof newBrowserDuckDb).toBe("function");
  });

  it("rejects a path without self-hosted bundles instead of starting a worker", async () => {
    await expect(newBrowserDuckDb({ path: "opfs://app.duckdb" })).rejects.toThrow(
      'Cannot open DuckDB database "opfs://app.duckdb": OPFS needs self-hosted `bundles`',
    );
  });
});
