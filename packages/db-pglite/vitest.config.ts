import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Each test starts a fresh PGlite (Postgres in WASM) instance, which takes
    // 6-13 s under parallel load across the workspace. Headroom for the test
    // bodies and the beforeEach/afterEach hooks that create them.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
