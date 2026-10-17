import type { DoSqlStorage } from "../src/index.js";

/** What every probe must give: "ok", or an error whose text matches the pattern. */
export const PROBE_EXPECTATIONS: Record<string, "ok" | RegExp> = {
  begin: /not authorized/,
  savepoint: /not authorized/,
  pragma: /not authorized/,
  fts5Trigram: "ok",
  fts5PorterUnicode61: "ok",
  jsonEach: "ok",
  multiStatementExec: "ok",
  params100: "ok",
  params200: /too many SQL variables/,
  blob1900k: "ok",
  blob2500k: /too big/,
  blobReadsAsArrayBuffer: "ok",
};

/** Run each probe against fresh tables of `storage`; each result is "ok" or "error: <message>". */
export function probeDoSqlite(storage: DoSqlStorage): Record<string, string> {
  const run = (query: string, ...bindings: unknown[]) =>
    storage.sql.exec(query, ...bindings).toArray();
  const out: Record<string, string> = {};
  const probe = (name: string, fn: () => void) => {
    try {
      fn();
      out[name] = "ok";
    } catch (error) {
      out[name] = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const expectRows = (rows: unknown[], n: number) => {
    if (rows.length !== n) throw new Error(`expected ${n} rows, got ${rows.length}`);
  };
  const params = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  run("CREATE TABLE probe_b (k INTEGER PRIMARY KEY, d BLOB)");
  probe("begin", () => run("BEGIN"));
  probe("savepoint", () => run("SAVEPOINT s"));
  probe("pragma", () => run("PRAGMA compile_options"));
  probe("fts5Trigram", () => {
    run("CREATE VIRTUAL TABLE probe_g USING fts5(c, tokenize='trigram')");
    run("INSERT INTO probe_g VALUES ('idx_lefthand')");
    expectRows(run("SELECT c FROM probe_g WHERE probe_g MATCH 'x_le'"), 1);
  });
  probe("fts5PorterUnicode61", () => {
    run(
      "CREATE VIRTUAL TABLE probe_p USING fts5(c, tokenize='porter unicode61 remove_diacritics 2')",
    );
    run("INSERT INTO probe_p VALUES ('Running cafés')");
    expectRows(run("SELECT c FROM probe_p WHERE probe_p MATCH 'run AND cafe'"), 1);
  });
  probe("jsonEach", () => expectRows(run("SELECT value FROM json_each(?)", "[1,2,3]"), 3));
  probe("multiStatementExec", () => {
    run("CREATE TABLE probe_m1 (a INTEGER); CREATE TABLE probe_m2 (a INTEGER)");
    run("INSERT INTO probe_m2 VALUES (1)");
  });
  probe("params100", () =>
    run(
      `SELECT 1 WHERE 1 IN (${params(100)
        .fill(0)
        .map(() => "?")
        .join(",")})`,
      ...params(100),
    ),
  );
  probe("params200", () =>
    run(
      `SELECT 1 WHERE 1 IN (${params(200)
        .fill(0)
        .map(() => "?")
        .join(",")})`,
      ...params(200),
    ),
  );
  probe("blob1900k", () => run("INSERT INTO probe_b VALUES (1, ?)", new ArrayBuffer(1_900_000)));
  probe("blob2500k", () => run("INSERT INTO probe_b VALUES (2, ?)", new ArrayBuffer(2_500_000)));
  probe("blobReadsAsArrayBuffer", () => {
    const value = run("SELECT d FROM probe_b WHERE k = 1")[0]?.d;
    if (!(value instanceof ArrayBuffer)) {
      throw new Error(`read back ${Object.prototype.toString.call(value)}`);
    }
  });
  return out;
}
