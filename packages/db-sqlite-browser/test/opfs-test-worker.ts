import { newBrowserSqliteDb } from "../src/index.js";

type Message = { path: string; action: "write" | "count" };
const scope = globalThis as unknown as {
  onmessage: ((event: { data: Message }) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = async ({ data }) => {
  try {
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
