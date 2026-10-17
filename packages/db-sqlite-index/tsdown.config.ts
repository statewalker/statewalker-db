import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    vector: "src/vector/index.ts",
    ngram: "src/ngram/index.ts",
  },
  format: "esm",
  dts: true,
});
