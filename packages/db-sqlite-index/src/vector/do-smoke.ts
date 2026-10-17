import type { Db } from "@statewalker/db-api";
import { VectorIndex } from "./vector-index.js";

const check = (ok: boolean, message: string) => {
  if (!ok) throw new Error(`vector smoke: ${message}`);
};

/** Run inside a real Durable Object by db-sqlite-do's `pnpm test:do`. */
export const vectorDoScenarios = [
  {
    name: "vector: multi-part segment rows, 150 ids in one delete, read-back",
    async run(db: Db) {
      const dims = 256;
      const n = 1100; // flat list; float block 4 × 1100 × 256 ≈ 1.1 MB → 2 parts
      const index = new VectorIndex({
        db,
        prefix: "smoke_",
        dims,
        autoCompactAt: Number.POSITIVE_INFINITY,
      });
      await index.init();
      // Well-spread vectors: a sin(i * 7 + j) phase ramp makes ids ~150 apart near-duplicates.
      const vector = (i: number) =>
        Float32Array.from({ length: dims }, (_, j) => Math.sin((i * 7919 + j * 104729) ** 2));
      await index.upsert(
        Array.from({ length: n }, (_, i) => ({ id: i + 1, vector: vector(i + 1) })),
      );
      check((await index.compact()) === n, "compact sealed every vector");
      const [parts] = await db.query<{ n: number }>("SELECT count(*) AS n FROM smoke_f32");
      check(Number(parts?.n) >= 2, `expected ≥ 2 float parts, got ${parts?.n}`);
      const gone = Array.from({ length: 150 }, (_, i) => i + 1);
      await index.delete(gone);
      const hit = await index.search(vector(500), { k: 1, exact: true });
      check(hit[0]?.id === 500, `nearest of 500 is ${hit[0]?.id}`);
      const back = await index.getVectors([1, 500]);
      check(!back.has(1) && back.has(500), "getVectors returns only live ids");
    },
  },
];
