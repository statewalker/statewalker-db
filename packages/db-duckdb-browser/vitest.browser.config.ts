import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Vitest browser-mode config for the DuckDB-WASM adapter.
 *
 * Runs the `*.browser.test.ts` conformance files in a real headless Chromium
 * via Playwright. Kept separate from the Node config (`vitest.config.ts`) so a
 * plain `vitest run` never spawns a duckdb-wasm Worker in Node.
 *
 * The default (jsDelivr) DuckDB bundle is fetched from the CDN by the browser
 * page, so the run needs outbound network access from Chromium.
 *
 * Launch with: `pnpm test:browser` (needs a Chromium binary — run
 * `pnpm exec playwright install chromium` once).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
