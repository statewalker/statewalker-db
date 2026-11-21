import type { Db } from "@statewalker/db-api";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { describe, expect, it } from "vitest";
import { errorCode, newDbRpcServer } from "./index.js";

const id = (n: number) => `stream-${String(n).padStart(10, "0")}`;

async function filledDb(rows: number, value = (i: number) => `row ${i}`): Promise<Db> {
  const db = newDoSqliteDb(newFakeDoStorage());
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v)");
  for (let i = 1; i <= rows; i += 50) {
    const ids = Array.from({ length: Math.min(50, rows - i + 1) }, (_, k) => i + k);
    await db.query("INSERT INTO t (id, v) SELECT value, NULL FROM json_each(?)", [
      JSON.stringify(ids),
    ]);
  }
  for (let i = 1; i <= rows; i++) await db.query("UPDATE t SET v = ? WHERE id = ?", [value(i), i]);
  return db;
}

describe("paging", () => {
  it("answers a small result in one page and keeps nothing open", async () => {
    const server = newDbRpcServer({ db: await filledDb(3) });
    const result = await server.query("SELECT id FROM t ORDER BY id");
    expect(result.pages).toBe(1);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(server.openStreams()).toBe(0);
  });

  it("an empty result is one empty page", async () => {
    const server = newDbRpcServer({ db: await filledDb(0) });
    expect(await server.query("SELECT id FROM t")).toMatchObject({ pages: 1, rows: [] });
  });

  it("cuts a result into pages of at most pageRows rows, served in any order and again", async () => {
    const server = newDbRpcServer({ db: await filledDb(10), pageRows: 4 });
    const { streamId, pages, rows } = await server.query("SELECT id FROM t ORDER BY id", [], {
      streamId: id(1),
    });
    expect(streamId).toBe(id(1));
    expect(pages).toBe(3);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(server.openStreams()).toBe(1);
    const last = await server.readPage(streamId, 2);
    expect(last).toEqual({ rows: [{ id: 9 }, { id: 10 }], done: true });
    const middle = await server.readPage(streamId, 1);
    expect(middle).toEqual({ rows: [{ id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }], done: false });
    expect(await server.readPage(streamId, 1)).toEqual(middle);
    expect((await server.readPage(streamId, 0)).rows).toEqual(rows);
    await server.closeQuery(streamId);
    expect(server.openStreams()).toBe(0);
    await expect(server.readPage(streamId, 1)).rejects.toThrow(/^UNKNOWN_STREAM/);
    await server.closeQuery(streamId); // again: nothing happens
  });

  it("keeps each page within about pageBytes; a larger row goes alone", async () => {
    const big = "x".repeat(3000);
    const db = await filledDb(20, (i) => (i === 7 ? big.repeat(4) : big));
    const server = newDbRpcServer({ db, pageBytes: 10_000 });
    const { streamId, pages, rows } = await server.query("SELECT id, v FROM t ORDER BY id");
    const all = [rows];
    for (let k = 1; k < pages; k++) all.push((await server.readPage(streamId, k)).rows);
    expect(all.flat().map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const page of all) {
      const size = page.reduce((n, r) => n + String(r.v).length, 0);
      if (page.some((r) => r.id === 7)) expect(page).toHaveLength(1);
      else expect(size).toBeLessThanOrEqual(10_000);
    }
  });

  it("counts BLOB bytes and multi-byte text towards pageBytes", async () => {
    const db = newDoSqliteDb(newFakeDoStorage());
    await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, d)");
    for (let i = 0; i < 4; i++)
      await db.query("INSERT INTO b (d) VALUES (?)", [new Uint8Array(600)]);
    for (let i = 0; i < 4; i++) await db.query("INSERT INTO b (d) VALUES (?)", ["é".repeat(300)]);
    const server = newDbRpcServer({ db, pageBytes: 1300 });
    const { pages } = await server.query("SELECT d FROM b");
    expect(pages).toBe(4);
  });

  it("refuses a page outside the result", async () => {
    const server = newDbRpcServer({ db: await filledDb(10), pageRows: 4 });
    const { streamId } = await server.query("SELECT id FROM t", [], { streamId: id(2) });
    for (const bad of [3, -1, 1.5, Number.NaN, "1" as unknown as number]) {
      await expect(server.readPage(streamId, bad)).rejects.toThrow(/^INVALID/);
    }
  });
});

describe("keyed retries", () => {
  it("a query delivered twice with one streamId runs once; both get the same answer", async () => {
    const db = await filledDb(0);
    const server = newDbRpcServer({ db });
    const sql = "INSERT INTO t (v) VALUES ('x') RETURNING id";
    const [a, b] = await Promise.all([
      server.query(sql, [], { streamId: id(3) }),
      server.query(sql, [], { streamId: id(3) }),
    ]);
    const c = await server.query(sql, [], { streamId: id(3) });
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(await db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 1 }]);
  });

  it("an exec or flush delivered twice with one requestId runs once, failures too", async () => {
    const db = await filledDb(0);
    let flushes = 0;
    const server = newDbRpcServer({ db: { ...db, flush: async () => void flushes++ } });
    const insert = "INSERT INTO t (v) VALUES ('x')";
    await Promise.all([
      server.exec(insert, { requestId: id(4) }),
      server.exec(insert, { requestId: id(4) }),
    ]);
    await server.exec(insert, { requestId: id(4) });
    expect(await db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 1 }]);
    await server.exec(insert); // no requestId: runs every time
    await server.exec(insert);
    expect(await db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 3 }]);
    await expect(server.exec("NOT SQL", { requestId: id(5) })).rejects.toThrow(/syntax/);
    await expect(server.exec("NOT SQL", { requestId: id(5) })).rejects.toThrow(/syntax/);
    await server.flush({ requestId: id(6) });
    await server.flush({ requestId: id(6) });
    expect(flushes).toBe(1);
  });

  it("forgets answers after idleTimeout and beyond maxRequests", async () => {
    let now = 0;
    const db = await filledDb(0);
    const server = newDbRpcServer({ db, idleTimeout: 100, maxRequests: 2, now: () => now });
    const insert = "INSERT INTO t (v) VALUES ('x')";
    await server.exec(insert, { requestId: id(7) });
    now = 200;
    server.sweep();
    await server.exec(insert, { requestId: id(7) }); // forgotten: runs again
    await server.exec(insert, { requestId: id(8) });
    await server.exec(insert, { requestId: id(9) });
    await server.exec(insert, { requestId: id(7) }); // pushed out by 8 and 9: runs again
    expect(await db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 5 }]);
  });

  it("refuses an id of the wrong form", async () => {
    const server = newDbRpcServer({ db: await filledDb(0) });
    for (const bad of ["short", "x".repeat(129), "has space in it xxxx", 42 as unknown as string]) {
      await expect(server.query("SELECT 1", [], { streamId: bad })).rejects.toThrow(/^INVALID/);
      await expect(server.exec("SELECT 1", { requestId: bad })).rejects.toThrow(/^INVALID/);
    }
  });
});

describe("lifecycle", () => {
  it("drops a result idle for idleTimeout", async () => {
    let now = 0;
    const server = newDbRpcServer({
      db: await filledDb(10),
      pageRows: 2,
      idleTimeout: 100,
      now: () => now,
    });
    const { streamId } = await server.query("SELECT id FROM t", [], { streamId: id(10) });
    now = 90;
    await server.readPage(streamId, 1); // keeps it alive
    now = 180;
    expect(server.sweep()).toBe(0);
    now = 300;
    expect(server.sweep()).toBe(1);
    await expect(server.readPage(streamId, 2)).rejects.toThrow(/^UNKNOWN_STREAM/);
  });

  it("refuses a result past maxStreams before running it", async () => {
    const db = await filledDb(10);
    const server = newDbRpcServer({ db, pageRows: 2, maxStreams: 1 });
    await server.query("SELECT id FROM t", [], { streamId: id(11) });
    const write = server.query("INSERT INTO t (v) VALUES ('x') RETURNING id", [], {
      streamId: id(12),
    });
    await expect(write).rejects.toThrow(/^TOO_MANY_STREAMS/);
    expect(errorCode(await write.catch((e) => e))).toBe("TOO_MANY_STREAMS");
    expect(await db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 10 }]);
    // Whether a result needs a stream is known only once it ran: every query waits for room.
    await expect(server.query("SELECT 1 AS one")).rejects.toThrow(/^TOO_MANY_STREAMS/);
    await server.closeQuery(id(11));
    expect((await server.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });

  it("close() drops every result and refuses later calls; the Db stays open", async () => {
    const db = await filledDb(10);
    const server = newDbRpcServer({ db, pageRows: 2 });
    const { streamId } = await server.query("SELECT id FROM t", [], { streamId: id(13) });
    await server.close();
    expect(server.openStreams()).toBe(0);
    await expect(server.readPage(streamId, 1)).rejects.toThrow(/^ABORTED/);
    await expect(server.query("SELECT 1")).rejects.toThrow(/^ABORTED/);
    await expect(server.exec("SELECT 1")).rejects.toThrow(/^ABORTED/);
    expect(await db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 10 }]);
  });

  it("sweeps on a timer with sweepInterval", async () => {
    let now = 0;
    const server = newDbRpcServer({
      db: await filledDb(10),
      pageRows: 2,
      idleTimeout: 10,
      sweepInterval: 5,
      now: () => now,
    });
    await server.query("SELECT id FROM t", [], { streamId: id(14) });
    now = 100;
    await new Promise((r) => setTimeout(r, 30));
    expect(server.openStreams()).toBe(0);
    await server.close();
  });

  it("passes the Db's errors through, and a code survives a structured clone", async () => {
    const server = newDbRpcServer({ db: await filledDb(0) });
    await expect(server.query("SELECT * FROM missing")).rejects.toThrow(/no such table/);
    const error = await server.readPage(id(15), 0).catch((e) => e);
    expect(errorCode(error)).toBe("UNKNOWN_STREAM");
    expect(errorCode(structuredClone(error))).toBe("UNKNOWN_STREAM");
    expect(errorCode(new Error("no such table"))).toBeUndefined();
  });
});
