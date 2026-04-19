import { connect } from "@tursodatabase/database";

type Row = Record<string, unknown>;

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

function parseVectorJson(input: string): string {
  const value = JSON.parse(input);
  if (!Array.isArray(value) || value.some((x) => typeof x !== "number")) {
    throw new Error("Vector must be a JSON array of numbers");
  }
  return JSON.stringify(value);
}

async function main(): Promise<void> {
  setStatus("Opening local Turso database…");

  const db = await connect("demo-search.db");

  db.prepare(`
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      embedding F32_BLOB(4)
    )
  `).run();

  db.prepare(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      title,
      body,
      content='docs',
      content_rowid='id'
    )
  `).run();

  db.prepare(`
    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, title, body)
      VALUES (new.id, new.title, new.body);
    END
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS docs_embedding_idx
    ON docs(libsql_vector_idx(embedding))
  `).run();

  function resetData(): void {
    db.prepare(`DELETE FROM docs`).run();

    const insert = db.prepare(`
      INSERT INTO docs (id, title, body, embedding)
      VALUES (?, ?, ?, vector32(?))
    `);

    const sampleDocs: Array<[number, string, string, string]> = [
      [
        1,
        "SQLite basics",
        "SQLite is a compact embedded database. FTS5 helps with keyword search.",
        "[0.10,0.20,0.30,0.40]",
      ],
      [
        2,
        "Turso overview",
        "Turso builds on libSQL and supports vector search and local database usage.",
        "[0.12,0.22,0.28,0.39]",
      ],
      [
        3,
        "Semantic search",
        "Vector indexes help find meaning-based matches instead of exact keywords.",
        "[0.82,0.15,0.11,0.09]",
      ],
      [
        4,
        "Full text ranking",
        "FTS5 can rank lexical matches using bm25 and the MATCH operator.",
        "[0.09,0.18,0.31,0.41]",
      ],
      [
        5,
        "Hybrid retrieval",
        "A common pattern is to combine keyword retrieval with semantic vector search.",
        "[0.11,0.21,0.29,0.41]",
      ],
    ];

    for (const row of sampleDocs) {
      insert.run(...row);
    }
  }

  function ftsSearch(query: string): Row[] {
    const stmt = db.prepare(`
      SELECT rowid AS id, title, bm25(docs_fts) AS score
      FROM docs_fts
      WHERE docs_fts MATCH ?
      ORDER BY score
      LIMIT 10
    `);
    return stmt.all(query) as Row[];
  }

  function vectorSearch(queryVectorJson: string): Row[] {
    const stmt = db.prepare(`
      SELECT d.id, d.title, v.distance
      FROM vector_top_k('docs_embedding_idx', vector32(?), 10) AS v
      JOIN docs AS d ON d.rowid = v.id
      ORDER BY v.distance ASC
    `);
    return stmt.all(queryVectorJson) as Row[];
  }

  function hybridSearch(textQuery: string, queryVectorJson: string): Row[] {
    const stmt = db.prepare(`
      WITH
      fts AS (
        SELECT rowid AS id, bm25(docs_fts) AS fts_score
        FROM docs_fts
        WHERE docs_fts MATCH ?
        LIMIT 20
      ),
      vec AS (
        SELECT id, distance
        FROM vector_top_k('docs_embedding_idx', vector32(?), 20)
      )
      SELECT d.id, d.title,
        COALESCE(fts.fts_score,1000.0) AS fts_score,
        COALESCE(vec.distance,1000.0) AS vec_distance
      FROM docs d
      LEFT JOIN fts ON fts.id = d.id
      LEFT JOIN vec ON vec.id = d.id
      WHERE fts.id IS NOT NULL OR vec.id IS NOT NULL
      LIMIT 10
    `);

    return stmt.all(textQuery, queryVectorJson) as Row[];
  }

  resetData();
  setStatus("Database ready.");

  ftsBtn.onclick = () => renderRows("FTS results", ftsSearch(textQueryEl.value.trim()));
  vecBtn.onclick = () =>
    renderRows("Vector results", vectorSearch(parseVectorJson(vecQueryEl.value.trim())));
  hybridBtn.onclick = () =>
    renderRows(
      "Hybrid results",
      hybridSearch(hybridTextQueryEl.value.trim(), parseVectorJson(hybridVecQueryEl.value.trim())),
    );

  resetBtn.onclick = () => {
    resetData();
    resultsEl.innerHTML = "";
    setStatus("Demo data reset.");
  };
}

main();
