import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["*.test.ts"],
    // Each test packs a whole workspace closure — every `pnpm pack` runs that
    // package's `prepack` build — and then does a real `npm install` of the
    // tarballs. Minutes, not milliseconds; the 5s default times these out.
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
