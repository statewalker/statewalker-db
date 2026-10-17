import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Vitest browser-mode config for the sqlite-wasm adapter: runs `*.browser.test.ts` in headless
 * Chromium. `@sqlite.org/sqlite-wasm` finds its `sqlite3.wasm` through `import.meta.url`, so it
 * is kept out of Vite's dependency pre-bundling, which would rewrite that URL. Workers are ES
 * modules so the OPFS fixture can import the driver.
 *
 * Launch with `pnpm test:browser` (run `pnpm exec playwright install chromium` once).
 */
export default defineConfig({
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
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
