// Real SQLite in the browser via the official @sqlite.org/sqlite-wasm build.
// Vector search is done in JS (cosine distance over the stored float32 blobs)
// rather than with sqlite-vec — see README for why the prebuilt sqlite-vec wasm
// was not usable. FTS5 is standard SQLite and runs in the database directly.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

type Row = Record<string, unknown>;

// The exec() overload we use returns object rows; narrow the loose lib type.
type ExecResult = (opts: {
  sql: string;
  bind?: unknown[];
  rowMode?: "object";
  returnValue?: "resultRows";
}) => Row[];

const statusEl = document.getElementById("status") as HTMLDivElement;
const resultsEl = document.getElementById("results") as HTMLDivElement;

const textQueryEl = document.getElementById("textQuery") as HTMLInputElement;
const vecQueryEl = document.getElementById("vecQuery") as HTMLInputElement;
const hybridTextQueryEl = document.getElementById("hybridTextQuery") as HTMLInputElement;
const hybridVecQueryEl = document.getElementById("hybridVecQuery") as HTMLInputElement;

const ftsBtn = document.getElementById("ftsBtn") as HTMLButtonElement;
const vecBtn = document.getElementById("vecBtn") as HTMLButtonElement;
const hybridBtn = document.getElementById("hybridBtn") as HTMLButtonElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRows(title: string, rows: Row[]): void {
  const items = rows
    .map((row) => {
      const body = Object.entries(row)
        .map(([k, v]) => `<div><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</div>`)
        .join("");
      return `<div class="card">${body}</div>`;
    })
    .join("");

  resultsEl.innerHTML = `
    <h2>${escapeHtml(title)}</h2>
    ${rows.length === 0 ? "<p class='muted'>No results</p>" : items}
  `;
}

function parseVector(input: string): number[] {
  const value = JSON.parse(input);
  if (!Array.isArray(value) || value.some((x) => typeof x !== "number")) {
    throw new Error("Vector must be a JSON array of numbers");
  }
  return value;
}

// float32 bytes for storage as a real SQLite BLOB.
function toBlob(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

// Read a stored BLOB back into numbers (copy to guarantee 4-byte alignment).
function fromBlob(blob: unknown): number[] {
  const bytes = blob as Uint8Array;
  return Array.from(new Float32Array(new Uint8Array(bytes).buffer));
}

// Cosine distance (1 - cosine similarity): 0 = identical direction, larger = farther.
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}

async function main(): Promise<void> {
  setStatus("Opening in-memory SQLite database…");

  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(":memory:");
  const execRows = db.exec.bind(db) as ExecResult;

  // Content table. `embedding` is a plain SQLite BLOB of float32 bytes.
  db.exec(`
    CREATE TABLE docs (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      embedding BLOB NOT NULL
    )
  `);

  // Portable FTS5 external-content index, kept in sync by a trigger.
  db.exec(`
    CREATE VIRTUAL TABLE docs_fts USING fts5(
      title,
      body,
      content='docs',
      content_rowid='id'
    )
  `);

  db.exec(`
    CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, title, body)
      VALUES (new.id, new.title, new.body);
    END
  `);

  function resetData(): void {
    db.exec(`DELETE FROM docs`);

    const sampleDocs: Array<[number, string, string, number[]]> = [
      [
        1,
        "SQLite basics",
        "SQLite is a compact embedded database. FTS5 helps with keyword search.",
        [0.1, 0.2, 0.3, 0.4],
      ],
      [
        2,
        "SQLite wasm overview",
        "The official sqlite-wasm build runs real SQLite in the browser.",
        [0.12, 0.22, 0.28, 0.39],
      ],
      [
        3,
        "Semantic search",
        "Vector similarity helps find meaning-based matches instead of exact keywords.",
        [0.82, 0.15, 0.11, 0.09],
      ],
      [
        4,
        "Full text ranking",
        "FTS5 can rank lexical matches using bm25 and the MATCH operator.",
        [0.09, 0.18, 0.31, 0.41],
      ],
      [
        5,
        "Hybrid retrieval",
        "A common pattern is to combine keyword retrieval with semantic vector search.",
        [0.11, 0.21, 0.29, 0.41],
      ],
    ];

    for (const [id, title, body, embedding] of sampleDocs) {
      db.exec({
        sql: `INSERT INTO docs (id, title, body, embedding) VALUES (?, ?, ?, ?)`,
        bind: [id, title, body, toBlob(embedding)],
      });
    }
  }

  function ftsSearch(query: string): Row[] {
    return execRows({
      sql: `
        SELECT rowid AS id, title, bm25(docs_fts) AS score
        FROM docs_fts
        WHERE docs_fts MATCH ?
        ORDER BY score
        LIMIT 10
      `,
      bind: [query],
      rowMode: "object",
      returnValue: "resultRows",
    });
  }

  function vectorSearch(queryVector: number[]): Row[] {
    const rows = execRows({
      sql: `SELECT id, title, embedding FROM docs`,
      rowMode: "object",
      returnValue: "resultRows",
    });
    return rows
      .map((r) => ({
        id: r.id,
        title: r.title,
        distance: cosineDistance(queryVector, fromBlob(r.embedding)),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);
  }

  function hybridSearch(textQuery: string, queryVector: number[]): Row[] {
    const ftsScores = new Map<unknown, number>();
    for (const r of ftsSearch(textQuery)) ftsScores.set(r.id, r.score as number);

    const rows = execRows({
      sql: `SELECT id, title, embedding FROM docs`,
      rowMode: "object",
      returnValue: "resultRows",
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      fts_score: ftsScores.get(r.id) ?? 1000.0,
      vec_distance: cosineDistance(queryVector, fromBlob(r.embedding)),
    }));
  }

  resetData();
  setStatus("Database ready (real SQLite / @sqlite.org/sqlite-wasm, in-memory).");

  ftsBtn.onclick = () => renderRows("FTS results", ftsSearch(textQueryEl.value.trim()));
  vecBtn.onclick = () =>
    renderRows("Vector results (JS cosine)", vectorSearch(parseVector(vecQueryEl.value.trim())));
  hybridBtn.onclick = () =>
    renderRows(
      "Hybrid results",
      hybridSearch(hybridTextQueryEl.value.trim(), parseVector(hybridVecQueryEl.value.trim())),
    );

  resetBtn.onclick = () => {
    resetData();
    resultsEl.innerHTML = "";
    setStatus("Demo data reset.");
  };
}

main().catch((err) => {
  setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  throw err;
});
