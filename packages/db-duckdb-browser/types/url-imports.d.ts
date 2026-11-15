// Vite `?url` imports, used by the browser tests to self-host the duckdb-wasm
// bundles (Vite resolves them to same-origin URLs). Kept outside `src/` so it
// is not published; vite itself is not a dependency of this package.
declare module "*?url" {
  const url: string;
  export default url;
}
