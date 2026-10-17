/**
 * SQLite transaction behaviour as plain async scenarios, with no test framework
 * import, so the same file runs under Vitest (runSqliteTransactionConformance)
 * and inside a real Durable Object (the db-sqlite-do `test:do` worker).
 * Each scenario gets a fresh, empty Db and throws on the first failed check.
 */
import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";

export type SqliteTransactionScenario = { name: string; run(db: Db): Promise<void> };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`scenario check failed: ${message}`);
}

async function count(db: Db, where = "1"): Promise<number> {
  const rows = await db.query<{ n: number }>(`SELECT count(*) AS n FROM t WHERE ${where}`);
  return Number(rows[0]?.n);
}

const setup = (db: Db) => db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, b BLOB)");

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const sqliteTransactionScenarios: SqliteTransactionScenario[] = [
  {
    name: "commits every statement and returns the callback's value",
    async run(db) {
      await setup(db);
      const value = await inTransaction(db, async (tx) => {
        await tx.query("INSERT INTO t (k) VALUES (?)", ["a"]);
        await tx.query("INSERT INTO t (k) VALUES (?)", ["b"]);
        return 42;
      });
      check(value === 42, `returned ${value}`);
      check((await count(db)) === 2, "both rows are committed");
    },
  },
  {
    name: "rolls back every statement when the callback throws after a timer",
    async run(db) {
      await setup(db);
      const boom = new Error("boom");
      let caught: unknown;
      try {
        await inTransaction(db, async (tx) => {
          await tx.query("INSERT INTO t (k) VALUES ('a')");
          await sleep(5);
          await tx.query("INSERT INTO t (k) VALUES ('b')");
          throw boom;
        });
      } catch (error) {
        caught = error;
      }
      check(caught === boom, "the callback's own error is rethrown");
      check((await count(db)) === 0, "no row survives the rollback");
    },
  },
  {
    name: "an outer call issued during a transaction waits for its commit",
    async run(db) {
      await setup(db);
      const first = inTransaction(db, async (tx) => {
        await tx.query("INSERT INTO t (k) VALUES ('a')");
        await sleep(10);
        await tx.query("INSERT INTO t (k) VALUES ('a')");
      });
      const second = inTransaction(db, async (tx) => {
        const rows = await tx.query<{ n: number }>("SELECT count(*) AS n FROM t");
        return Number(rows[0]?.n);
      });
      const plain = count(db);
      await first;
      check((await second) === 2, "the second transaction saw both rows");
      check((await plain) === 2, "a plain query saw both rows");
    },
  },
  {
    name: "a plain write issued during a transaction survives its rollback",
    async run(db) {
      await setup(db);
      const failing = inTransaction(db, async (tx) => {
        await tx.query("INSERT INTO t (k) VALUES ('tx')");
        await sleep(10);
        throw new Error("rollback");
      });
      const plain = db.query("INSERT INTO t (k) VALUES ('plain')");
      await failing.catch(() => undefined);
      await plain;
      check((await count(db, "k = 'plain'")) === 1, "the plain write is kept");
      check((await count(db, "k = 'tx'")) === 0, "the transaction's write is rolled back");
    },
  },
  {
    name: "the callback's error survives a rollback SQLite already performed",
    async run(db) {
      await db.exec("CREATE TABLE u (k TEXT UNIQUE ON CONFLICT ROLLBACK)");
      await db.exec("INSERT INTO u VALUES ('a')");
      let caught: unknown;
      try {
        await inTransaction(db, async (tx) => {
          await tx.query("INSERT INTO u VALUES ('b')");
          await tx.query("INSERT INTO u VALUES ('a')");
        });
      } catch (error) {
        caught = error;
      }
      check(
        /unique|constraint/i.test(errorText(caught)),
        `constraint error reached the caller: ${errorText(caught)}`,
      );
      const rows = await db.query<{ n: number }>("SELECT count(*) AS n FROM u");
      check(Number(rows[0]?.n) === 1, "the db is usable and the transaction is rolled back");
    },
  },
  {
    name: "nested inTransaction on the transaction handle rejects",
    async run(db) {
      await setup(db);
      let nested: unknown;
      await inTransaction(db, async (tx) => {
        try {
          await inTransaction(tx, async () => undefined);
        } catch (error) {
          nested = error;
        }
        await tx.query("INSERT INTO t (k) VALUES ('outer')");
      });
      check(/nest/i.test(errorText(nested)), `nested call rejected: ${errorText(nested)}`);
      check((await count(db)) === 1, "the outer transaction still commits");
    },
  },
  {
    name: "the transaction handle rejects once the transaction is finished",
    async run(db) {
      await setup(db);
      let saved: Db | undefined;
      await inTransaction(db, async (tx) => {
        saved = tx;
      });
      let late: unknown;
      try {
        await saved?.query("INSERT INTO t (k) VALUES ('late')");
      } catch (error) {
        late = error;
      }
      check(/finished/i.test(errorText(late)), `late use rejected: ${errorText(late)}`);
      check((await count(db)) === 0, "the late write did not happen");
    },
  },
  {
    name: "a Db wrapped by the caller is rejected, not run without a transaction",
    async run(db) {
      const wrapped: Db = {
        query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      };
      let caught: unknown;
      try {
        await inTransaction(wrapped, async () => undefined);
      } catch (error) {
        caught = error;
      }
      check(/wrap/i.test(errorText(caught)), `wrapper rejected: ${errorText(caught)}`);
    },
  },
  {
    name: "changes() and RETURNING report the rows a statement touched",
    async run(db) {
      await setup(db);
      await db.exec("INSERT INTO t (k) VALUES ('a'), ('b'), ('c')");
      await inTransaction(db, async (tx) => {
        await tx.query("UPDATE t SET k = 'z' WHERE id <= 2");
        const changed = await tx.query<{ n: number }>("SELECT changes() AS n");
        check(Number(changed[0]?.n) === 2, `changes() = ${changed[0]?.n}`);
        const inserted = await tx.query<{ id: number }>(
          "INSERT INTO t (k) VALUES ('r') RETURNING id",
        );
        check(inserted.length === 1 && Number(inserted[0]?.id) === 4, "RETURNING gives the new id");
      });
    },
  },
  {
    name: "a BLOB comes back as a Uint8Array with the same bytes",
    async run(db) {
      await setup(db);
      const bytes = new Uint8Array([0, 1, 127, 255]);
      await db.query("INSERT INTO t (k, b) VALUES ('plain', ?)", [bytes]);
      await inTransaction(db, (tx) => tx.query("INSERT INTO t (k, b) VALUES ('tx', ?)", [bytes]));
      const rows = await db.query<{ b: unknown }>("SELECT b FROM t ORDER BY id");
      for (const row of rows) {
        check(
          row.b instanceof Uint8Array,
          `BLOB read back as ${Object.prototype.toString.call(row.b)}`,
        );
        check(Array.from(row.b as Uint8Array).join() === "0,1,127,255", "BLOB bytes are unchanged");
      }
    },
  },
  {
    name: "more than 100 ids bind as one JSON parameter through json_each",
    async run(db) {
      await setup(db);
      const ids = Array.from({ length: 150 }, (_, i) => i + 1);
      await db.query("INSERT INTO t (id) SELECT value FROM json_each(?)", [JSON.stringify(ids)]);
      const wanted = JSON.stringify(ids.slice(0, 120));
      const rows = await db.query<{ n: number }>(
        "SELECT count(*) AS n FROM t WHERE id IN (SELECT value FROM json_each(?))",
        [wanted],
      );
      check(Number(rows[0]?.n) === 120, `json_each matched ${rows[0]?.n}`);
    },
  },
  {
    name: "exec runs every statement of a multi-statement string",
    async run(db) {
      await db.exec("CREATE TABLE m1 (a INTEGER); CREATE TABLE m2 (a INTEGER)");
      await db.exec("INSERT INTO m2 VALUES (1)");
      const rows = await db.query<{ a: number }>("SELECT a FROM m2");
      check(rows.length === 1, "the second statement created m2");
    },
  },
  {
    name: "close waits for a running transaction to finish",
    async run(db) {
      await setup(db);
      const running = inTransaction(db, async (tx) => {
        await sleep(10);
        await tx.query("INSERT INTO t (k) VALUES ('late')");
        return "done";
      });
      await db.close();
      check((await running) === "done", "the transaction finished before close");
    },
  },
];
