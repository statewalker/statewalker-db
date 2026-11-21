import { describe, expect, it } from "vitest";
import { inReadOnlyTransaction, newSerialisedSqliteDb, type SqliteEngine } from "./index.js";

/** An engine that records what reaches it. */
function recordingEngine() {
  const calls: [string, string][] = [];
  const engine: SqliteEngine = {
    all: (sql) => {
      calls.push(["all", sql]);
      return [];
    },
    exec: (sql) => {
      calls.push(["exec", sql]);
    },
    close: () => {},
  };
  return { engine, calls };
}

describe("inReadOnlyTransaction on an engine without its own transactions", () => {
  it("runs exec one statement per engine call, each through `all`, between BEGIN and ROLLBACK", async () => {
    // `all` runs exactly one statement (node:sqlite's prepare compiles only the first), so text
    // the splitter might misread as part of a statement never runs as a statement of its own.
    const { engine, calls } = recordingEngine();
    const db = newSerialisedSqliteDb(engine);
    await inReadOnlyTransaction(db, (tx) =>
      tx.exec(
        "INSERT INTO t VALUES (';'); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
      ),
    );
    expect(calls).toEqual([
      ["exec", "BEGIN"],
      ["all", "INSERT INTO t VALUES (';')"],
      ["all", "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END"],
      ["exec", "ROLLBACK"],
    ]);
  });

  it("checks every statement before running any", async () => {
    const { engine, calls } = recordingEngine();
    const db = newSerialisedSqliteDb(engine);
    await expect(
      inReadOnlyTransaction(db, (tx) => tx.exec("INSERT INTO t VALUES (1); COMMIT")),
    ).rejects.toThrow(/read-only/);
    expect(calls).toEqual([
      ["exec", "BEGIN"],
      ["exec", "ROLLBACK"],
    ]);
  });
});
