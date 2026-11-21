import type { Db } from "@statewalker/db-api";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { describe, expect, it } from "vitest";
import { type DbRpc, newDbRpcClient, newDbRpcServer } from "./index.js";
import { sleep, transport } from "./test-helpers.js";

async function numbers(n: number): Promise<Db> {
  const db = newDoSqliteDb(newFakeDoStorage());
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v)");
  await db.query("INSERT INTO t (id, v) SELECT value, 'v' || value FROM json_each(?)", [
    JSON.stringify(Array.from({ length: n }, (_, i) => i + 1)),
  ]);
  return db;
}

describe("newDbRpcClient", () => {
  it("reads a result of many pages in order and closes it", async () => {
    const server = newDbRpcServer({ db: await numbers(1000), pageRows: 7 });
    const { rpc, calls } = transport(server, { maxDelay: 2, seed: 3 });
    const db = newDbRpcClient({ rpc });
    const rows = await db.query<{ id: number; v: string }>("SELECT id, v FROM t ORDER BY id");
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    expect(rows[999]).toEqual({ id: 1000, v: "v1000" });
    expect(server.openStreams()).toBe(0);
    const pages = calls.filter((c) => c.method === "readPage");
    expect(pages).toHaveLength(Math.ceil(1000 / 7) - 1);
    for (const c of pages)
      expect((c.answer as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(7);
    expect(calls.filter((c) => c.method === "closeQuery")).toHaveLength(1);
  });

  it("keeps at most readAhead page requests in flight", async () => {
    const server = newDbRpcServer({ db: await numbers(100), pageRows: 5 });
    let inFlight = 0;
    let most = 0;
    const rpc: DbRpc = {
      query: server.query,
      readPage: async (id, k) => {
        most = Math.max(most, ++inFlight);
        await sleep(2);
        inFlight--;
        return server.readPage(id, k);
      },
      closeQuery: server.closeQuery,
      exec: server.exec,
      flush: server.flush,
    };
    const rows = await newDbRpcClient({ rpc, readAhead: 3 }).query("SELECT id FROM t");
    expect(rows).toHaveLength(100);
    expect(most).toBe(3);
  });

  it("sends a fresh key with every call", async () => {
    const { rpc, calls } = transport(newDbRpcServer({ db: await numbers(1) }));
    const db = newDbRpcClient({ rpc });
    await db.query("SELECT 1");
    await db.query("SELECT 1");
    await db.exec("SELECT 1");
    await db.exec("SELECT 1");
    await db.flush?.();
    await db.flush?.();
    const keys = calls.map((c) => {
      const options = c.args[c.method === "query" ? 2 : c.method === "flush" ? 0 : 1] as {
        streamId?: string;
        requestId?: string;
      };
      return options.streamId ?? options.requestId;
    });
    expect(new Set(keys).size).toBe(6);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("closes the result when a page fails, and rejects with that failure", async () => {
    const server = newDbRpcServer({ db: await numbers(50), pageRows: 5 });
    const rpc: DbRpc = {
      query: server.query,
      readPage: async (id, k) => {
        if (k === 3) throw new Error("lost page");
        return server.readPage(id, k);
      },
      closeQuery: server.closeQuery,
      exec: server.exec,
      flush: server.flush,
    };
    await expect(newDbRpcClient({ rpc }).query("SELECT id FROM t")).rejects.toThrow("lost page");
    expect(server.openStreams()).toBe(0);
  });

  it("runs calls one at a time in call order, over a transport that reorders them", async () => {
    const server = newDbRpcServer({ db: await numbers(0) });
    const { rpc } = transport(server, { maxDelay: 5, seed: 11 });
    const db = newDbRpcClient({ rpc });
    const done: Promise<unknown>[] = [];
    for (let i = 1; i <= 20; i++)
      done.push(db.query("INSERT INTO t (id, v) VALUES (?, ?)", [i, i]));
    const read = db.query<{ ids: string }>("SELECT group_concat(id) AS ids FROM t");
    await Promise.all(done);
    expect((await read)[0]?.ids).toBe(Array.from({ length: 20 }, (_, i) => i + 1).join(","));
  });

  it("carries BLOBs, bigints and nulls", async () => {
    const db = newDbRpcClient({
      rpc: transport(newDbRpcServer({ db: await numbers(0) })).rpc,
    });
    const [row] = await db.query("SELECT ? AS b, ? AS big, NULL AS n", [
      new Uint8Array([1, 2, 255]),
      2n ** 60n,
    ]);
    expect(row).toEqual({ b: new Uint8Array([1, 2, 255]), big: 2n ** 60n, n: null });
  });

  it("after close, calls reject with `db-rpc: the database is closed`; close waits for earlier calls", async () => {
    const server = newDbRpcServer({ db: await numbers(3) });
    const db = newDbRpcClient({ rpc: transport(server, { maxDelay: 5 }).rpc });
    const pending = db.query("SELECT id FROM t");
    const closing = db.close();
    await expect(db.query("SELECT 1")).rejects.toThrow("db-rpc: the database is closed");
    await expect(db.exec("SELECT 1")).rejects.toThrow("db-rpc: the database is closed");
    await expect(db.flush?.()).rejects.toThrow("db-rpc: the database is closed");
    expect(await pending).toHaveLength(3);
    await closing;
    await db.close(); // again: nothing happens
    expect(await server.query("SELECT count(*) AS n FROM t")).toMatchObject({ rows: [{ n: 3 }] });
  });
});
