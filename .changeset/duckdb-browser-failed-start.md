---
"@statewalker/db-duckdb-browser": patch
---

A failed start no longer leaks its Web Worker: if instantiating the engine, opening the path or connecting rejects, the engine and worker are terminated and the jsDelivr Blob URL is revoked before the original error is rethrown. `path` without self-hosted `bundles` now rejects up front with `Cannot open DuckDB database "<path>": OPFS needs self-hosted \`bundles\``, instead of starting the cross-origin jsDelivr worker that crashes on OPFS file I/O.
