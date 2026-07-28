import { defineConfig } from "vite";

// @sqlite.org/sqlite-wasm is an Emscripten ES module: exclude it from dep
// pre-bundling so esbuild does not rewrite its `import.meta.url` wasm resolution.
// It locates its sibling sqlite3.wasm via `new URL("sqlite3.wasm", import.meta.url)`,
// which Vite emits as a hashed asset for `build` and serves in `dev`.
export default defineConfig({
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
