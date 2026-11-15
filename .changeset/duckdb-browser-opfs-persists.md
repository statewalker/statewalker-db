---
"@statewalker/db-duckdb-browser": patch
---

OPFS databases persist again: pin `@duckdb/duckdb-wasm` to exactly `1.33.1-dev65.0` (was `^1.33.1-dev57.0`). With 1.33.1-dev57.0 a new `opfs://` database was never written to OPFS and was empty after a reopen (#74); 1.33.1-dev60.0 and later fix it. The pin is exact because npm compares `devN` prerelease tags as text, so a caret range would not select the intended build. The bundle shape (`mvp`/`eh`) is unchanged.
