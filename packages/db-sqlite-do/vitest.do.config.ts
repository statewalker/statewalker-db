import { defineConfig } from "vitest/config";

/** The real Durable Object suite: needs celld 0.6.x on PATH and built workspace packages. */
export default defineConfig({
  test: {
    include: ["test-do/**/*.do.test.ts"],
    globalSetup: ["test-do/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
