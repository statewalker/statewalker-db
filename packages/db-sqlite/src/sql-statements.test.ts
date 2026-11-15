import { describe, expect, it } from "vitest";
import { countSqlStatements } from "./sql-statements.js";

describe("countSqlStatements", () => {
  it.each(["", "   \n\t", ";", " ; ;\n", "-- a comment", "/* a comment */", "/* unterminated"])(
    "finds no statement in %j",
    (sql) => {
      expect(countSqlStatements(sql)).toBe("empty");
    },
  );

  it.each([
    "SELECT 1",
    "SELECT 1;",
    "SELECT 1; ; -- done\n /* ; */",
    "SELECT 'a;b', \"c;d\", `e;f`, [g;h]",
    "SELECT 'it''s; fine'",
    "SELECT 1 -- ; SELECT 2",
    "SELECT 1 /* ; SELECT 2 */",
    "SELECT 'unterminated; SELECT 2",
    "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO u VALUES (1); DELETE FROM v; END;",
    "create temp trigger tr after insert on t begin select case when 1 then 2 end; end",
    "EXPLAIN SELECT 1;",
    "SELECT x'00ff';",
  ])("finds one statement in %j", (sql) => {
    expect(countSqlStatements(sql)).toBe("one");
  });

  it.each([
    "SELECT 1; SELECT 2",
    "INSERT INTO t VALUES (1);INSERT INTO t VALUES (2)",
    "SELECT 1; -- comment\nSELECT 2",
    "SELECT ';'; SELECT 2",
    "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END; SELECT 2",
    "CREATE TABLE end_table (end_col); SELECT 1",
    "SELECT 1; SELECT 'unterminated",
  ])("finds several statements in %j", (sql) => {
    expect(countSqlStatements(sql)).toBe("many");
  });
});
