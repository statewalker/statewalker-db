import { newBrowserSqliteDb } from "../src/index.js";

type Message =
  | { path: string; action: "write" | "count" }
  | { path: string; action: "open-many"; files: number; capacity?: number };
const scope = globalThis as unknown as {
  onmessage: ((event: { data: Message }) => void) | null;
  postMessage(message: unknown): void;
};

/** Open `files` databases at once, each with a write; report how many opened. */
async function openMany(path: string, files: number, capacity?: number): Promise<number> {
  const dbs = [];
  try {
    for (let i = 0; i < files; i++) {
      const db = await newBrowserSqliteDb({ path: `${path}-${i}.db`, capacity });
      dbs.push(db);
      await db.exec("CREATE TABLE IF NOT EXISTS p (v INTEGER); INSERT INTO p VALUES (1)");
    }
    return dbs.length;
  } finally {
    for (const db of dbs) await db.close();
  }
}

scope.onmessage = async ({ data }) => {
  try {
    if (data.action === "open-many") {
      scope.postMessage({ count: await openMany(data.path, data.files, data.capacity) });
      return;
    }
    const db = await newBrowserSqliteDb({ path: data.path });
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS p (v INTEGER)");
      if (data.action === "write") await db.exec("INSERT INTO p VALUES (42)");
      const [row] = await db.query<{ n: number }>("SELECT count(*) AS n FROM p");
      scope.postMessage({ count: Number(row?.n) });
    } finally {
      await db.close();
    }
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
