import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Vitest browser-mode config for the libSQL-WASM adapter.
 *
 * Runs the `*.browser.test.ts` conformance files in a real headless Chromium
 * via Playwright. Kept separate from the Node config (`vitest.config.ts`) so a
 * plain `vitest run` never tries to load WASM in Node.
 *
 * `newBrowserSqliteDb` defaults to fetching the engine from `/sqlite3.wasm`, so
 * we point Vite's `publicDir` at the libSQL package's `jswasm` folder — that
 * serves `sqlite3.wasm` (and its OPFS proxy) at the site root with no copy step.
 *
 * Launch with: `pnpm test:browser` (needs a Chromium binary — run
 * `pnpm exec playwright install chromium` once).
 */
const require = createRequire(import.meta.url);
const wasmDir = join(
  dirname(require.resolve("@libsql/libsql-wasm-experimental/package.json")),
  "sqlite-wasm/jswasm",
);

export default defineConfig({
  publicDir: wasmDir,
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
