import { vector } from "@electric-sql/pglite-pgvector";
import { runDbConformance } from "@statewalker/db-tests";
import { describe, expect, it } from "vitest";
import { newPgliteDb } from "./pglite-db.js";

runDbConformance((options) => newPgliteDb(options), { placeholder: "$1" });

describe("newPgliteDb", () => {
  it("loads the extensions it is given (pgvector, as indexer-pglite needs)", async () => {
    const db = await newPgliteDb({ extensions: { vector } });
    try {
      await db.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE v (e vector(3))");
      await db.query("INSERT INTO v VALUES ($1::vector)", ["[1,2,3]"]);
      const rows = await db.query<{ d: number }>("SELECT e <-> '[1,2,4]'::vector AS d FROM v");
      expect(rows[0]?.d).toBeCloseTo(1);
    } finally {
      await db.close();
    }
  });
});
