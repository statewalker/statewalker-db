/**
 * SQLite transaction behaviour as plain async scenarios, with no test framework
 * import, so the same file runs under Vitest (runSqliteTransactionConformance)
 * and inside a real Durable Object (the db-sqlite-do `test:do` worker).
 * Each scenario gets a fresh, empty Db and throws on the first failed check.
 */
import type { Db } from "@statewalker/db-api";
import { inReadOnlyTransaction, inTransaction } from "@statewalker/db-sqlite";

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
    name: "read-only: returns the callback's value and rolls back every write",
    async run(db) {
      await setup(db);
      await db.exec("INSERT INTO t (k) VALUES ('kept')");
      const value = await inReadOnlyTransaction(db, async (tx) => {
        await tx.query("INSERT INTO t (k) VALUES (?)", ["gone"]);
        await tx.exec("UPDATE t SET k = 'changed'; CREATE TABLE extra (a)");
        const seen = await tx.query<{ k: string }>("SELECT k FROM t ORDER BY id");
        return seen.map((r) => r.k).join(",");
      });
      check(value === "changed,changed", `the callback saw its own writes: ${value}`);
      const rows = await db.query<{ k: string }>("SELECT k FROM t");
      check(rows.length === 1 && rows[0]?.k === "kept", "no write persisted");
      const tables = await db.query("SELECT name FROM sqlite_master WHERE name = 'extra'");
      check(tables.length === 0, "the table created inside is gone");
    },
  },
  {
    name: "read-only: rolls back and rethrows when the callback throws",
    async run(db) {
      await setup(db);
      const boom = new Error("boom");
      let caught: unknown;
      try {
        await inReadOnlyTransaction(db, async (tx) => {
          await tx.query("INSERT INTO t (k) VALUES ('a')");
          await sleep(5);
          throw boom;
        });
      } catch (error) {
        caught = error;
      }
      check(caught === boom, `the callback's own error is rethrown: ${errorText(caught)}`);
      check((await count(db)) === 0, "no row survives");
      await db.query("INSERT INTO t (k) VALUES ('after')");
      check((await count(db)) === 1, "the db still commits plain writes");
    },
  },
  {
    name: "read-only: statements that would end the transaction or reach outside it are refused",
    async run(db) {
      await setup(db);
      const attempts = [
        "COMMIT; INSERT INTO t (k) VALUES ('escaped')",
        // SQLite skips a vertical tab between statements, as it skips any whitespace.
        "SELECT 1;\vCOMMIT; INSERT INTO t (k) VALUES ('escaped')",
        "SELECT 1;\v\fCOMMIT; INSERT INTO t (k) VALUES ('escaped')",
        // A Tcl-style variable ($a(...), :a(...), @a(...), #a(...)) runs to the first ")" or
        // whitespace, quotes included: the quote inside it starts no literal.
        "SELECT $a(');COMMIT;INSERT INTO t(k) VALUES('escaped');SELECT '",
        "SELECT :a(');COMMIT;INSERT INTO t(k) VALUES('escaped');SELECT '",
        'SELECT @a(");COMMIT;INSERT INTO t(k) VALUES(1);SELECT "',
        "SELECT $a([);COMMIT;INSERT INTO t(k) VALUES(2);SELECT ]",
        "SELECT #a(`);COMMIT;INSERT INTO t(k) VALUES(3);SELECT `",
        "SELECT $a::b(');COMMIT;INSERT INTO t(k) VALUES(4);SELECT '",
        "end",
        "ROLLBACK; INSERT INTO t (k) VALUES ('escaped')",
        "SELECT 1; /* c */ release sp",
        "SAVEPOINT sp",
        "BEGIN",
        "ATTACH ':memory:' AS other",
        "DETACH other",
        "PRAGMA foreign_keys = ON",
        "VACUUM",
        // Not starting with a keyword: where a scanner and SQLite could disagree, refused.
        "(SELECT 1)",
      ];
      for (const sql of attempts) {
        for (const how of ["exec", "query"] as const) {
          if (how === "query" && sql.includes(";")) continue;
          let caught: unknown;
          try {
            await inReadOnlyTransaction<unknown>(db, (tx) =>
              how === "exec" ? tx.exec(sql) : tx.query(sql),
            );
          } catch (error) {
            caught = error;
          }
          check(
            /read-only/i.test(errorText(caught)),
            `${how} ${sql} refused: ${errorText(caught)}`,
          );
        }
      }
      check((await count(db)) === 0, "nothing escaped the transaction");
    },
  },
  {
    name: "read-only: after a failed statement the handle refuses every later call",
    async run(db) {
      await db.exec("CREATE TABLE u (k TEXT UNIQUE)");
      await db.exec("INSERT INTO u VALUES ('a')");
      let later: unknown;
      try {
        await inReadOnlyTransaction(db, async (tx) => {
          // OR ROLLBACK ends SQLite's transaction itself: what follows would run outside it.
          await tx.query("INSERT OR ROLLBACK INTO u VALUES ('a')").catch(() => undefined);
          try {
            await tx.query("INSERT INTO u VALUES ('b')");
          } catch (error) {
            later = error;
          }
        });
      } catch {
        // The platform may also fail the transaction (DO: "no transaction is active").
      }
      check(/read-only/i.test(errorText(later)), `later call refused: ${errorText(later)}`);
      const rows = await db.query<{ k: string }>("SELECT k FROM u");
      check(rows.length === 1, `nothing persisted: ${rows.map((r) => r.k).join(",")}`);
    },
  },
  {
    name: "read-only: reads committed data; nesting and wrapped Dbs are rejected",
    async run(db) {
      await setup(db);
      await db.query("INSERT INTO t (k) VALUES ('a'), ('b')");
      let nested: unknown;
      const n = await inReadOnlyTransaction(db, async (tx) => {
        try {
          await inReadOnlyTransaction(tx, async () => undefined);
        } catch (error) {
          nested = error;
        }
        return count(tx);
      });
      check(n === 2, `read ${n} rows`);
      check(/nest/i.test(errorText(nested)), `nested call rejected: ${errorText(nested)}`);
      let wrapped: unknown;
      try {
        const wrapper: Db = { query: db.query, exec: db.exec, close: db.close };
        await inReadOnlyTransaction(wrapper, async () => 1);
      } catch (error) {
        wrapped = error;
      }
      check(/wrap/i.test(errorText(wrapped)), `wrapper rejected: ${errorText(wrapped)}`);
    },
  },
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
    name: "a COMMIT that fails on a deferred foreign key rolls back and rejects",
    async run(db) {
      await db.exec("PRAGMA foreign_keys = ON");
      await db.exec(
        "CREATE TABLE parent (id INTEGER PRIMARY KEY); " +
          "CREATE TABLE child (id INTEGER PRIMARY KEY, " +
          "p INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
      );
      let caught: unknown;
      try {
        await inTransaction(db, async (tx) => {
          // Deferred: the statement succeeds, the violation is found only at COMMIT.
          await tx.query("INSERT INTO child (p) VALUES (99)");
          return "committed";
        });
      } catch (error) {
        caught = error;
      }
      check(/foreign key/i.test(errorText(caught)), `COMMIT rejected: ${errorText(caught)}`);
      const rows = await db.query<{ n: number }>("SELECT count(*) AS n FROM child");
      check(Number(rows[0]?.n) === 0, "the failed transaction is rolled back");
      await inTransaction(db, async (tx) => {
        await tx.query("INSERT INTO parent (id) VALUES (1)");
        await tx.query("INSERT INTO child (p) VALUES (1)");
      });
      const after = await db.query<{ n: number }>("SELECT count(*) AS n FROM child");
      check(Number(after[0]?.n) === 1, "the next transaction commits");
    },
  },
  {
    name: "boolean, undefined and Date parameters bind as 1/0, NULL and an ISO 8601 string",
    async run(db) {
      await db.exec("CREATE TABLE p (k TEXT, a, b, c, d)");
      const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
      await db.query("INSERT INTO p VALUES (?, ?, ?, ?, ?)", ["x", true, false, undefined, date]);
      const [row] = await db.query<Record<string, unknown>>(
        "SELECT a, b, c, typeof(c) AS tc, d, datetime(d) AS dt FROM p",
      );
      check(row?.a === 1, `true bound as ${String(row?.a)}`);
      check(row?.b === 0, `false bound as ${String(row?.b)}`);
      check(row?.c === null && row?.tc === "null", `undefined bound as ${String(row?.tc)}`);
      check(row?.d === "2026-01-02T03:04:05.006Z", `Date bound as ${String(row?.d)}`);
      check(row?.dt === "2026-01-02 03:04:05", `SQLite reads the date: ${String(row?.dt)}`);
      const [inTx] = await inTransaction(db, (tx) =>
        tx.query<Record<string, unknown>>("SELECT ? AS k, ? AS t, ? AS u", ["y", true, undefined]),
      );
      check(inTx?.t === 1 && inTx?.u === null, "the transaction handle normalises too");
      let invalid: unknown;
      try {
        await db.query("SELECT ?, ?", ["z", new Date(Number.NaN)]);
      } catch (error) {
        invalid = error;
      }
      check(/invalid date/i.test(errorText(invalid)), `invalid Date: ${errorText(invalid)}`);
    },
  },
  {
    name: "a parameter SQLite cannot bind rejects with its index and type, and nothing runs",
    async run(db) {
      await setup(db);
      const unsupported: [string, unknown][] = [
        ["Object", {}],
        ["Map", new Map()],
        ["Array", [1, 2]],
        ["function", () => 1],
        ["symbol", Symbol("s")],
        ["Object", Object.create(null)],
        ["String", new String("boxed")],
      ];
      const attempts: [string, number, () => Promise<unknown>][] = [];
      for (const [type, value] of unsupported) {
        // First: node:sqlite would take a leading object as named parameters and shift the rest.
        attempts.push([
          `${type} first`,
          1,
          () => db.query("INSERT INTO t (k, b) VALUES (?, ?)", [value, "x"]),
        ]);
        attempts.push([
          `${type} second`,
          2,
          () => db.query("INSERT INTO t (k, b) VALUES (?, ?)", ["x", value]),
        ]);
        attempts.push([
          `${type} first in tx`,
          1,
          () =>
            inTransaction(db, (tx) => tx.query("INSERT INTO t (k, b) VALUES (?, ?)", [value, "x"])),
        ]);
      }
      for (const [label, index, attempt] of attempts) {
        let caught: unknown;
        try {
          await attempt();
        } catch (error) {
          caught = error;
        }
        const type = label.split(" ")[0] as string;
        check(
          caught instanceof TypeError,
          `${label} rejected with a TypeError: ${errorText(caught)}`,
        );
        check(
          new RegExp(`parameter ${index}\\b`).test(errorText(caught)) &&
            errorText(caught).includes(type),
          `${label} names parameter ${index} and ${type}: ${errorText(caught)}`,
        );
      }
      check((await count(db)) === 0, `nothing was written, found ${await count(db)} rows`);
    },
  },
  {
    name: "an ArrayBuffer and any ArrayBuffer view bind as a BLOB of exactly their bytes",
    async run(db) {
      await setup(db);
      const backing = new Uint8Array([9, 1, 2, 3, 4, 9]).buffer;
      const inputs: [string, unknown][] = [
        ["ArrayBuffer", new Uint8Array([1, 2, 3, 4]).buffer],
        ["Uint8Array slice", new Uint8Array(backing, 1, 4)],
        ["DataView", new DataView(backing, 1, 4)],
        ["Int8Array", new Int8Array(backing, 1, 4)],
        ["Uint16Array", new Uint16Array(new Uint8Array([1, 2, 3, 4]).buffer)],
      ];
      for (const [k, value] of inputs) {
        await db.query("INSERT INTO t (k, b) VALUES (?, ?)", [k, value]);
      }
      await inTransaction(db, (tx) =>
        tx.query("INSERT INTO t (k, b) VALUES (?, ?)", ["tx ArrayBuffer", inputs[0]?.[1]]),
      );
      const rows = await db.query<{ k: string; b: unknown }>("SELECT k, b FROM t ORDER BY id");
      check(rows.length === inputs.length + 1, `${rows.length} rows written`);
      for (const row of rows) {
        check(row.b instanceof Uint8Array, `${row.k} read back as a Uint8Array`);
        const got = Array.from(row.b as Uint8Array).join();
        check(got === "1,2,3,4", `${row.k} bound as ${got}`);
      }
    },
  },
  {
    name: "an empty ArrayBuffer or view binds as an empty BLOB, not NULL",
    async run(db) {
      await setup(db);
      const inputs: [string, unknown][] = [
        ["empty ArrayBuffer", new ArrayBuffer(0)],
        ["view over an empty ArrayBuffer", new Uint8Array(new ArrayBuffer(0))],
        ["empty DataView", new DataView(new ArrayBuffer(0))],
        ["empty slice", new Uint8Array(4).subarray(2, 2)],
      ];
      for (const [k, value] of inputs) {
        await db.query("INSERT INTO t (k, b) VALUES (?, ?)", [k, value]);
      }
      const rows = await db.query<{ k: string; t: unknown }>(
        "SELECT k, typeof(b) AS t FROM t ORDER BY id",
      );
      check(rows.length === inputs.length, `${rows.length} rows written`);
      for (const row of rows) check(row.t === "blob", `${row.k} stored as ${String(row.t)}`);
    },
  },
  {
    name: "integers above 2^53 round-trip as bigint, safe integers come back as numbers",
    async run(db) {
      await db.exec("CREATE TABLE g (k INTEGER PRIMARY KEY, v INTEGER)");
      const values = [2n ** 60n, -(2n ** 60n), 9007199254740993n, 5n];
      for (const [k, v] of values.entries()) {
        await db.query("INSERT INTO g (k, v) VALUES (?, ?)", [k, v]);
      }
      const rows = await db.query<{ v: unknown }>("SELECT v FROM g ORDER BY k");
      const got = rows.map((r) => r.v);
      check(got[0] === 2n ** 60n, `2^60 read back as ${typeof got[0]} ${String(got[0])}`);
      check(got[1] === -(2n ** 60n), `-2^60 read back as ${typeof got[1]} ${String(got[1])}`);
      check(got[2] === 9007199254740993n, `2^53+1 read back as ${String(got[2])}`);
      check(got[3] === 5, `a safe bigint parameter read back as ${typeof got[3]}`);
      const [literal] = await db.query<Record<string, unknown>>(
        "SELECT 9007199254740993 AS big, 9007199254740991 AS safe, count(*) AS n FROM g",
      );
      check(literal?.big === 9007199254740993n, `literal read back as ${typeof literal?.big}`);
      check(
        literal?.safe === 9007199254740991,
        `MAX_SAFE_INTEGER read back as ${typeof literal?.safe}`,
      );
      check(literal?.n === 4, `count(*) read back as ${typeof literal?.n}`);
    },
  },
  {
    name: "integer numbers bind as INTEGER, other numbers as REAL",
    async run(db) {
      const [types] = await db.query<Record<string, unknown>>(
        "SELECT typeof(?) AS i, typeof(?) AS r, typeof(?) AS z",
        [5, 2.5, 0],
      );
      check(types?.i === "integer", `5 bound as ${String(types?.i)}`);
      check(types?.r === "real", `2.5 bound as ${String(types?.r)}`);
      check(types?.z === "integer", `0 bound as ${String(types?.z)}`);
      await db.exec("CREATE TABLE tx_text (k INTEGER PRIMARY KEY, t TEXT)");
      await db.query("INSERT INTO tx_text (k, t) VALUES (?, ?)", [1, 5]);
      const [row] = await db.query<{ t: unknown }>("SELECT t FROM tx_text WHERE k = ?", [1]);
      check(row?.t === "5", `5 stored in a TEXT column as ${JSON.stringify(row?.t)}`);
    },
  },
  {
    name: "query and exec on a plain Db run in call order",
    async run(db) {
      const order: string[] = [];
      const step = (label: string) => () => {
        order.push(label);
      };
      const calls = [
        db.exec("CREATE TABLE o (n INTEGER)").then(step("create")),
        db.query("INSERT INTO o VALUES (1)").then(step("insert 1")),
        db.exec("INSERT INTO o VALUES (2)").then(step("insert 2")),
        db
          .query<{ n: number }>("SELECT n FROM o ORDER BY n")
          .then((rows) => order.push(`select ${rows.map((r) => r.n).join()}`)),
        db.exec("DELETE FROM o WHERE n = 1").then(step("delete 1")),
        db
          .query<{ n: number }>("SELECT count(*) AS n FROM o")
          .then((rows) => order.push(`count ${rows[0]?.n}`)),
      ];
      await Promise.all(calls);
      const want = "create|insert 1|insert 2|select 1,2|delete 1|count 1";
      check(order.join("|") === want, `ran as ${order.join("|")}`);
    },
  },
  {
    name: "query rejects SQL with more than one statement and runs none of it",
    async run(db) {
      await db.exec("CREATE TABLE ms (n INTEGER)");
      for (const [sql, params] of [
        ["INSERT INTO ms VALUES (1); INSERT INTO ms VALUES (2); SELECT 7 AS z", []],
        ["INSERT INTO ms VALUES (?); SELECT 1", [1]],
        ["INSERT INTO ms VALUES (3);\n-- comment\nINSERT INTO ms VALUES (4)", []],
      ] as [string, unknown[]][]) {
        let caught: unknown;
        try {
          await db.query(sql, params);
        } catch (error) {
          caught = error;
        }
        check(/one statement/i.test(errorText(caught)), `${sql} rejected: ${errorText(caught)}`);
      }
      const rows = await db.query<{ n: number }>("SELECT count(*) AS n FROM ms");
      check(Number(rows[0]?.n) === 0, `no statement ran, found ${rows[0]?.n} rows`);
      // One statement with an empty tail, or with semicolons inside literals, comments or a
      // trigger body, is still one statement.
      const one = await db.query<Record<string, unknown>>(
        "SELECT 'a;b' AS [c;d] /* ; */ ; -- trailing ; comment\n ;",
      );
      check(one.length === 1 && one[0]?.["c;d"] === "a;b", "one statement with a tail runs");
      await db.query(
        "CREATE TRIGGER ms_double AFTER INSERT ON ms WHEN new.n < 10 BEGIN " +
          "INSERT INTO ms VALUES (new.n * 10); SELECT CASE WHEN 1 THEN 1 END; END;",
      );
      await db.query("INSERT INTO ms VALUES (?)", [2]);
      const after = await db.query<{ n: number }>("SELECT n FROM ms ORDER BY n");
      check(after.map((r) => r.n).join() === "2,20", "the trigger created by query fires");
    },
  },
  {
    name: "query and exec reject empty SQL with a clear message",
    async run(db) {
      const attempts: [string, () => Promise<unknown>][] = [
        ["query('')", () => db.query("")],
        ["query(' ')", () => db.query("  \n\t")],
        ["query(';')", () => db.query(" ; ;")],
        ["query(comment)", () => db.query("-- nothing here\n/* or here */")],
        ["exec('')", () => db.exec("")],
        ["exec(' ')", () => db.exec("  \n")],
      ];
      for (const [label, attempt] of attempts) {
        let caught: unknown;
        try {
          await attempt();
        } catch (error) {
          caught = error;
        }
        check(/empty/i.test(errorText(caught)), `${label} rejected: ${errorText(caught)}`);
      }
      const rows = await db.query<{ x: number }>("SELECT 1 AS x");
      check(rows[0]?.x === 1, "the Db is still usable");
    },
  },
  {
    name: "close can be called more than once",
    async run(db) {
      await db.close();
      await db.close();
      await Promise.all([db.close(), db.close()]);
      let caught: unknown;
      try {
        await db.query("SELECT 1");
      } catch (error) {
        caught = error;
      }
      check(/closed/i.test(errorText(caught)), `a call after close rejects: ${errorText(caught)}`);
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
