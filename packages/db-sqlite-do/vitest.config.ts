import { configDefaults, defineConfig } from "vitest/config";

/** Unit tests on the node:sqlite fake. The real-celld suite in test-do/ runs only through `test:do`. */
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "test-do/**"] },
});
