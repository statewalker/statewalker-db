# SQLite FTS5 + Vector Search Demo

## What it is

A private Vite app (`@statewalker/sqlite-search-demo`, not published) that
runs SQLite in the browser with the official `@sqlite.org/sqlite-wasm` build.
It loads five sample documents into an in-memory database and offers three
searches: FTS5 keyword search, vector search by cosine distance, and a hybrid
view that shows both scores per document. It uses `@sqlite.org/sqlite-wasm`
directly, not the `@statewalker/db-*` drivers.

## The shape: one page, one script

```
index.html          inputs and buttons (FTS, vector, hybrid, reset)
src/main.ts         opens :memory:, creates the tables, runs the searches
vite.config.ts      keeps @sqlite.org/sqlite-wasm out of dependency pre-bundling

docs (id, title, body, embedding BLOB)  --AFTER INSERT trigger-->  docs_fts (fts5: title, body)
```

## How to run it

From the repository root:

1. `pnpm install`
2. `pnpm --filter @statewalker/sqlite-search-demo dev`
3. Open the URL that Vite prints.

The page shows "Database ready (real SQLite / @sqlite.org/sqlite-wasm,
in-memory)." when it has loaded. "Reset demo data" reloads the five documents.

## Why it is the way it is

- **FTS5 runs in the database.** `docs_fts` is an external-content FTS5 table
  filled by an `AFTER INSERT` trigger on `docs`. Results are ranked with
  `bm25(docs_fts)` (lower is better).
- **Vector search runs in JavaScript.** Embeddings are stored as the bytes of
  a `Float32Array` in a plain `BLOB` column. The query vector is compared with
  every row by cosine distance in JS. For five documents this is exact and
  fast; it does not scale to a large corpus.
- **Why not `sqlite-vec`.** SQLite in WASM cannot `load_extension()` at
  runtime, so `sqlite-vec` would have to be compiled into a custom WASM binary.
  `@sqlite.org/sqlite-wasm` does not include it. The prebuilt bundle that does,
  `sqlite-vec-wasm-demo`, fails to start in every published version: its module
  runs `await createWasm(); run();` and only then registers the sqlite3 API via
  `Module.postRun.push(...)`, after `run()` has already consumed `postRun`.
  Initialization aborts with
  `Attempt to set Module.postRun after it has already been processed`. This
  happens with any bundler, so app code cannot work around it.
- **In-memory database.** No OPFS is used, so the page needs no
  cross-origin-isolation headers.
- **`optimizeDeps.exclude`.** `@sqlite.org/sqlite-wasm` finds its
  `sqlite3.wasm` with `new URL("sqlite3.wasm", import.meta.url)`. Vite's
  dependency pre-bundling would rewrite that, so the package is excluded. Vite
  then serves the WASM in `dev` and emits it as a hashed asset in `build`.

## What will surprise you

- **Hybrid results are not ranked.** "Hybrid search" lists every document with
  `fts_score` (bm25; `1000` when the document does not match the text query)
  and `vec_distance`. It does not combine the two into one ranking or sort by
  them.
- **Vectors have four dimensions, and length is not checked.** The sample
  embeddings have 4 elements; the inputs take a JSON array such as
  `[0.1,0.2,0.3,0.4]`. A longer query vector gives `NaN` distances; a shorter
  one is compared on its first elements only. Input that is not a JSON array of
  numbers throws `Vector must be a JSON array of numbers`.
- **Keep the `optimizeDeps.exclude` entry.** Without it, esbuild pre-bundles
  `@sqlite.org/sqlite-wasm` and rewrites the `import.meta.url` lookup of
  `sqlite3.wasm`.
- **Data does not survive a reload.** The database is `:memory:`.

## Reference

| Command (from the repository root) | What it does |
| --- | --- |
| `pnpm --filter @statewalker/sqlite-search-demo dev` | Vite dev server |
| `pnpm --filter @statewalker/sqlite-search-demo build` | production build into `apps/sqlite-search-demo/dist/` |
| `pnpm --filter @statewalker/sqlite-search-demo preview` | serve the production build |

Dependencies: `@sqlite.org/sqlite-wasm` (runtime); `vite`, `typescript` (dev).
