import type { DuckDBBundles } from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import type { Db } from "@statewalker/db-api";
import { afterEach, describe, expect, it } from "vitest";
import { newBrowserDuckDb } from "./browser-duckdb.js";

/**
 * OPFS persistence of the DuckDB-WASM adapter, in a real Chromium (Vitest
 * browser mode). Launched only by `vitest.browser.config.ts` (`test:browser`).
 *
 * OPFS needs a same-origin worker, so the bundles are self-hosted: Vite serves
 * the duckdb-wasm worker and wasm files from node_modules through `?url`
 * imports, as the README documents. The jsDelivr worker crashes on OPFS I/O.
 *
 * KNOWN BUG — both cases are `it.fails` until statewalker-db#74 is fixed (drop `.fails` then):
 * with @duckdb/duckdb-wasm 1.33.1-dev57.0 nothing reaches OPFS. On `OPEN` of an
 * `opfs://` path the worker creates `<name>` and `<name>.wal` (0 bytes) and
 * registers their sync access handles only when `handle.getSize()` is non-zero
 * (`prepareDBFileHandle` in `duckdb-browser-eh.worker.js`). A new file is
 * empty, so it is never registered, DuckDB keeps the database outside OPFS,
 * both files stay at 0 bytes after `CHECKPOINT` and `close()`, and the reopened
 * database has no tables ("Table with name notes does not exist!").
 */
const bundles: DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

describe("newBrowserDuckDb on OPFS", () => {
  // OPFS persists across tests in the same browser profile: every test gets a
  // fresh file name, removed (with its WAL) afterwards.
  let fileName: string | undefined;
  let open: Db | undefined;

  function newPath(): string {
    fileName = `persistence-${crypto.randomUUID()}.duckdb`;
    return `opfs://${fileName}`;
  }

  afterEach(async () => {
    if (open) await open.close();
    open = undefined;
    if (!fileName) return;
    const root = await navigator.storage.getDirectory();
    for (const name of [fileName, `${fileName}.wal`]) {
      await root.removeEntry(name).catch(() => {});
    }
    fileName = undefined;
  });

  async function writeRows(path: string): Promise<Db> {
    const db = await newBrowserDuckDb({ path, bundles });
    open = db;
    await db.exec("CREATE TABLE notes (id INTEGER, body VARCHAR)");
    await db.exec("INSERT INTO notes VALUES (1, 'hello'), (2, 'world')");
    return db;
  }

  async function readRows(path: string): Promise<unknown[]> {
    const db = await newBrowserDuckDb({ path, bundles });
    open = db;
    const rows = await db.query("SELECT id, body FROM notes ORDER BY id");
    await db.close();
    open = undefined;
    return rows;
  }

  const expected = [
    { id: 1, body: "hello" },
    { id: 2, body: "world" },
  ];

  it.fails("keeps rows across flush, close and reopen", async () => {
    const path = newPath();
    const db = await writeRows(path);
    await db.flush?.();
    await db.close();
    open = undefined;

    expect(await readRows(path)).toEqual(expected);
  });

  it.fails("keeps rows across close and reopen without flush", async () => {
    const path = newPath();
    const db = await writeRows(path);
    await db.close();
    open = undefined;

    expect(await readRows(path)).toEqual(expected);
  });
});
