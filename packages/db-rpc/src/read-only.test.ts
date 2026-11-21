import type { Db } from "@statewalker/db-api";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { describe, expect, it } from "vitest";
import { newDbRpcClient, newDbRpcServer } from "./index.js";
import { transport } from "./test-helpers.js";

const drivers: [string, () => Promise<Db>][] = [
  ["db-sqlite-do", async () => newDoSqliteDb(newFakeDoStorage())],
  ["db-sqlite-node", () => newNodeSqliteDb()],
];

describe.each(drivers)("a read-only server on %s", (_, makeDb) => {
  async function setup() {
    const db = await makeDb();
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.query("INSERT INTO t (id, v) SELECT value, 'v' || value FROM json_each(?)", [
      JSON.stringify(Array.from({ length: 100 }, (_, i) => i + 1)),
    ]);
    const server = newDbRpcServer({ db, readOnly: true, pageRows: 8 });
    const client = newDbRpcClient({ rpc: transport(server, { duplicate: 0.3 }).rpc });
    const count = async () => (await db.query<{ n: number }>("SELECT count(*) AS n FROM t"))[0]?.n;
    return { db, server, client, count };
  }

  it("reads, also across many pages", async () => {
    const { client } = await setup();
    const rows = await client.query<{ id: number }>("SELECT id FROM t ORDER BY id");
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it("no write persists, through query or exec; a write still answers inside its call", async () => {
    const { client, count } = await setup();
    const returned = await client.query("INSERT INTO t (v) VALUES ('x') RETURNING id");
    expect(returned).toEqual([{ id: 101 }]);
    await client.exec("DELETE FROM t; CREATE TABLE extra (a)");
    await client.query("UPDATE t SET v = ?", ["changed"]);
    expect(await count()).toBe(100);
    expect(await client.query("SELECT count(*) AS n FROM t WHERE v = 'changed'")).toEqual([
      { n: 0 },
    ]);
    expect(await client.query("SELECT name FROM sqlite_master WHERE name = 'extra'")).toEqual([]);
  });

  it("refuses SQL that would end the transaction, and nothing escapes", async () => {
    const { client, count } = await setup();
    await expect(client.exec("COMMIT; DELETE FROM t")).rejects.toThrow(/read-only/);
    await expect(client.query("ROLLBACK")).rejects.toThrow(/read-only/);
    await expect(client.exec("PRAGMA foreign_keys = ON")).rejects.toThrow(/read-only/);
    expect(await count()).toBe(100);
  });
});

describe("newDbRpcServer({ readOnly })", () => {
  it("refuses a Db that cannot roll back a read-only transaction", () => {
    const plain: Db = {
      query: async () => [],
      exec: async () => {},
      close: async () => {},
    };
    expect(() => newDbRpcServer({ db: plain, readOnly: true })).toThrow(/read-only/);
    expect(() => newDbRpcServer({ db: plain })).not.toThrow();
  });

  it("serves one Db read-only and read-write side by side", async () => {
    const db = newDoSqliteDb(newFakeDoStorage());
    await db.exec("CREATE TABLE t (v)");
    const reader = newDbRpcClient({ rpc: newDbRpcServer({ db, readOnly: true }) });
    const writer = newDbRpcClient({ rpc: newDbRpcServer({ db }) });
    await reader.exec("INSERT INTO t VALUES (1)");
    await writer.exec("INSERT INTO t VALUES (2)");
    expect(await reader.query("SELECT v FROM t")).toEqual([{ v: 2 }]);
  });
});
