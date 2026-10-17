import { runDbConformance, runSqliteTransactionConformance } from "@statewalker/db-tests";
import { describe, expect, it } from "vitest";
import { PROBE_EXPECTATIONS, probeDoSqlite } from "../test-do/platform-probe.js";
import { newDoSqliteDb } from "./do-sqlite-db.js";
import { newFakeDoStorage } from "./fake-do-storage.js";

// Same suites as every other SQLite driver, on the node:sqlite fake of ctx.storage.
runDbConformance(async () => newDoSqliteDb(newFakeDoStorage()), {
  placeholder: "?",
  skipFilePersistence: true,
});
runSqliteTransactionConformance(async () => newDoSqliteDb(newFakeDoStorage()));

describe("newFakeDoStorage", () => {
  // The same probe runs on real DO SQLite in `test:do`; both must meet the same expectations.
  it("matches the probed Durable Object SQLite behaviour", () => {
    const storage = newFakeDoStorage();
    try {
      const result = probeDoSqlite(storage);
      for (const [name, want] of Object.entries(PROBE_EXPECTATIONS)) {
        if (want === "ok") expect(result[name], name).toBe("ok");
        else expect(result[name], name).toMatch(want);
      }
    } finally {
      storage.close();
    }
  });

  it("rejects a typed array bound as a BLOB, as the driver must pass an ArrayBuffer", () => {
    const storage = newFakeDoStorage();
    try {
      storage.sql.exec("CREATE TABLE b (d BLOB)");
      expect(() => storage.sql.exec("INSERT INTO b VALUES (?)", new Uint8Array([1]))).toThrow(
        /ArrayBuffer/,
      );
    } finally {
      storage.close();
    }
  });
});
