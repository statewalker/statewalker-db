import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The big-batch scenarios (a batch larger than the 2 MB a DO accepts in one bound value) take
    // 2-6 s on a quiet machine and over 15 s when the whole workspace tests in parallel, so the
    // 5 s default fails them on load alone.
    testTimeout: 30_000,
  },
});
