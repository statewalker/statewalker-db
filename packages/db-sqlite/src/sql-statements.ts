/**
 * How many SQL statements a string holds, without running it: "empty" (only whitespace, comments
 * and semicolons), "one" (one statement, maybe followed by such a tail) or "many".
 *
 * A port of SQLite's own `sqlite3_complete()` state machine (src/complete.c): it knows string
 * literals ('…'), quoted identifiers ("…", `…`, […]), `--` and `/* … *\/` comments, and that
 * the semicolons inside a `CREATE TRIGGER … BEGIN … END` body do not end the statement. An
 * unterminated literal is content (SQLite reports the syntax error); an unterminated comment runs
 * to the end of the text.
 */
export type SqlStatementCount = "empty" | "one" | "many";

const SEMI = 0;
const WS = 1;
const OTHER = 2;
const EXPLAIN = 3;
const CREATE = 4;
const TEMP = 5;
const TRIGGER = 6;
const END = 7;

/** trans[state][token]; states 0 INVALID, 1 START, 2 NORMAL, 3 EXPLAIN, 4 CREATE, 5 TRIGGER, 6 SEMI, 7 END. */
const TRANS = [
  [1, 0, 2, 3, 4, 2, 2, 2],
  [1, 1, 2, 3, 4, 2, 2, 2],
  [1, 2, 2, 2, 2, 2, 2, 2],
  [1, 3, 3, 2, 4, 2, 2, 2],
  [1, 4, 2, 2, 2, 4, 5, 2],
  [6, 5, 5, 5, 5, 5, 5, 5],
  [6, 6, 5, 5, 5, 5, 5, 7],
  [1, 7, 5, 5, 5, 5, 5, 5],
];

const KEYWORDS: Record<string, number> = {
  create: CREATE,
  temp: TEMP,
  temporary: TEMP,
  trigger: TRIGGER,
  end: END,
  explain: EXPLAIN,
};

const isIdChar = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

export function countSqlStatements(sql: string): SqlStatementCount {
  return scanSqlStatements(sql).count;
}

/**
 * The first statement of `sql` without the semicolon that ends it and without the empty tail
 * after it (whitespace, comments, semicolons), for engines that reject such a tail (Durable
 * Object SQLite: "SQL code did not contain a statement"). Meant for SQL that
 * {@link countSqlStatements} counts as "one"; SQL without an ending semicolon comes back as is.
 */
export function firstSqlStatement(sql: string): string {
  const { firstEnd } = scanSqlStatements(sql);
  return firstEnd < 0 ? sql : sql.slice(0, firstEnd);
}

function scanSqlStatements(sql: string): { count: SqlStatementCount; firstEnd: number } {
  let firstEnd = -1; // index of the ";" that ends the first statement
  let state = 0;
  let content = false; // a token other than whitespace or ";" was seen
  let firstEnded = false; // the first statement with content has reached its ";"
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i] as string;
    let token: number;
    if (c === ";") {
      token = SEMI;
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      token = WS;
    } else if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) break; // an unterminated comment runs to the end, like whitespace
      i = close + 1;
      token = WS;
    } else if (c === "-" && sql[i + 1] === "-") {
      const eol = sql.indexOf("\n", i);
      if (eol < 0) break;
      i = eol;
      token = WS;
    } else if (c === "[" || c === "`" || c === '"' || c === "'") {
      const close = sql.indexOf(c === "[" ? "]" : c, i + 1);
      if (close < 0) return { count: firstEnded ? "many" : "one", firstEnd };
      i = close;
      token = OTHER;
    } else if (isIdChar(c)) {
      let j = i + 1;
      while (j < n && isIdChar(sql[j] as string)) j++;
      token = KEYWORDS[sql.slice(i, j).toLowerCase()] ?? OTHER;
      i = j - 1;
    } else {
      token = OTHER;
    }
    if (token !== SEMI && token !== WS) {
      if (firstEnded) return { count: "many", firstEnd };
      content = true;
    }
    state = TRANS[state]?.[token] ?? 2;
    if (token === SEMI && state === 1 && content && !firstEnded) {
      firstEnded = true;
      firstEnd = i;
    }
    i++;
  }
  return { count: content ? "one" : "empty", firstEnd };
}
