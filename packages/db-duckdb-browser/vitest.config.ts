import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (Node) config. The `*.browser.test.ts` conformance files run the
 * DuckDB-WASM adapter inside a real browser (Worker + WASM) and must NOT be
 * picked up by the plain `vitest run` (Node) invocation — they are excluded
 * here and run only through `vitest.browser.config.ts` (the `test:browser`
 * script).
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.browser.test.ts"],
  },
});
