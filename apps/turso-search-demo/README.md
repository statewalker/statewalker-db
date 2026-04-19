# Turso FTS5 + Vector Search Demo

Simple browser demo showing:

- SQLite **FTS5 full‑text search**
- Turso/libSQL **vector indexes**
- **Hybrid search** combining both

## Install

```bash
npm install
npm run dev
```

Then open the Vite URL in your browser.

## Features

- FTS keyword search using `MATCH` + `bm25`
- Semantic search using `vector_top_k`
- Hybrid query merging both results

