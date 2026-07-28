# SQLite FTS5 + Vector Search Demo

Simple browser demo running **real SQLite** — the official
[`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)
build — with **no Turso / libSQL**. It shows:

- SQLite **FTS5 full‑text search** (runs in the database)
- **Vector search** by cosine similarity over stored float32 blobs
- **Hybrid search** combining both

## Install

```bash
npm install
npm run dev
```

Then open the Vite URL in your browser.

## Features

- FTS keyword search using `MATCH` + `bm25` (an FTS5 external‑content virtual table)
- Semantic search: embeddings stored as real SQLite `BLOB`s, ranked by cosine
  distance computed in JS
- Hybrid query reporting both the bm25 score and the vector distance per document

## Real SQLite, not Turso/libSQL

The original demo depended on `@tursodatabase/database` and used libSQL‑proprietary
vector features (`F32_BLOB`, `libsql_vector_idx`, `vector32()`, `vector_top_k()`).
This version uses only real SQLite:

- **FTS5** is standard SQLite and is essentially unchanged (external‑content table
  + insert trigger + `bm25()` ranking).
- **Embeddings** are stored in a plain `BLOB` column (little‑endian float32), and
  **vector search** ranks documents by cosine distance computed in JavaScript.

### Why vector search is done in JS (and not with sqlite-vec)

Real‑SQLite vector search normally means [`sqlite-vec`](https://github.com/asg017/sqlite-vec)
(a `vec0` virtual table with `WHERE embedding MATCH ? ORDER BY distance`). A WASM
build of SQLite cannot `load_extension()` at runtime (no host filesystem or dynamic
linker inside the sandbox), so `sqlite-vec` must be **statically compiled into a
custom WASM binary** — the stock `@sqlite.org/sqlite-wasm` package does not ship one.

The upstream prebuilt bundle that does,
[`sqlite-vec-wasm-demo`](https://www.npmjs.com/package/sqlite-vec-wasm-demo) (Alex
Garcia / asg017), was evaluated and **is not currently dependable**: in every
published version its Emscripten module runs `await createWasm(); run();` and only
*afterwards* registers the sqlite3 API via `Module.postRun.push(...)`. Because the
wasm is already instantiated by then, `run()` executes synchronously and consumes
`postRun` before the API is registered, so initialization aborts with
`Attempt to set Module.postRun after it has already been processed`. This happens
regardless of bundler/transform (reproduced loading the module untouched from a
static file), so it cannot be worked around from app code.

The official `@sqlite.org/sqlite-wasm` build does **not** have this problem, so the
demo uses it and moves the vector step to JS. For a five‑document demo this is
exact and trivially fast; for a large corpus you would want a statically‑compiled
`sqlite-vec` wasm (once a stable prebuilt exists) or a server‑side SQLite with the
`sqlite-vec` extension loaded natively.

## How the wasm is loaded

The database is opened in‑memory (`:memory:`), so no OPFS / cross‑origin‑isolation
headers are required. `@sqlite.org/sqlite-wasm` is imported normally
(`import sqlite3InitModule from "@sqlite.org/sqlite-wasm"`); `vite.config.ts`
excludes it from dependency pre‑bundling so its `new URL("sqlite3.wasm",
import.meta.url)` wasm resolution is preserved — Vite emits the wasm as a hashed
asset for `build` and serves it in `dev`.
