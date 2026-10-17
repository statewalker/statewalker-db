import type { Db } from "@statewalker/db-api";
import { NgramStore } from "./ngram-store.js";

const check = (ok: boolean, message: string) => {
  if (!ok) throw new Error(`ngram smoke: ${message}`);
};

/** True when the index itself still offers candidates (candidateBudget 0 skips the verifier). */
const indexed = async (index: NgramStore, pattern: string) =>
  (await index.search(pattern, { candidateBudget: 0 })).truncated;

const ids = (result: { hits: { id: number }[] }) => result.hits.map((h) => h.id).join();

/** Run inside a real Durable Object by db-sqlite-do's `pnpm test:do`. */
export const ngramDoScenarios = (["fts5", "postings"] as const).map((store) => ({
  name: `ngram (${store}): upsert, overwrite, lone surrogate, drop inside a transaction`,
  async run(db: Db) {
    const prefix = `smoke_${store}_`;
    const index = new NgramStore({ db, prefix, store });
    await index.init(); // CREATE of the index tables (a contentless trigram table for fts5) in a transaction
    await index.upsert([
      { id: 1, text: "Hello World" },
      { id: 2, text: "hello there" },
      { id: 3, text: "lone \ud800 surrogate" },
    ]);
    check(
      ids(await index.search("hello", { caseSensitive: false })) === "1,2",
      "case-insensitive hits",
    );
    check(ids(await index.search("Hello")) === "1", "case-sensitive hits");
    check(ids(await index.search("surrogate")) === "3", "text with a lone surrogate is indexed");
    check((await index.getTexts([3])).get(3) === "lone \ufffd surrogate", "text made well-formed");
    check(await indexed(index, "World"), "index lacks the grams of 'World'");
    check(await indexed(index, "surrogate"), "index lacks the grams of 'surrogate'");
    await index.upsert([{ id: 1, text: "goodbye" }]); // replays the old text to remove its grams
    check(!(await indexed(index, "World")), "stale grams after overwrite");
    await index.upsert([{ id: 3, text: "lone \ud800 changed" }]);
    check(!(await indexed(index, "surrogate")), "stale grams after surrogate overwrite");
    await index.drop(); // DROP of the tables inside a transaction
    const [row] = await db.query<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE ?",
      [`${prefix}%`],
    );
    check(Number(row?.n) === 0, `tables left after drop: ${row?.n}`);
  },
}));
