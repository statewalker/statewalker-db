import { DurableObject } from "cloudflare:workers";
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { SCENARIOS } from "./scenarios.js";

type Reply = Record<string, unknown>;
type Stub = { scenario(name: string): Promise<Reply> };
type Env = { SMOKE: { idFromName(name: string): unknown; get(id: unknown): Stub } };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One DO per test id: runs one smoke scenario on newDoSqliteDb over its own storage. */
export class SmokeDo extends DurableObject {
  db = newDoSqliteDb(this.ctx.storage);

  async scenario(name: string): Promise<Reply> {
    const scenario = SCENARIOS.find((s) => s.name === name);
    if (!scenario) return { error: `unknown scenario: ${name}` };
    try {
      await scenario.run(this.db);
      return { ok: true };
    } catch (error) {
      return { error: errorText(error) };
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, kind, id = "default", name = ""] = new URL(request.url).pathname.split("/");
    if (kind !== "scenario") return new Response("not found", { status: 404 });
    const stub = env.SMOKE.get(env.SMOKE.idFromName(id));
    return Response.json(await stub.scenario(decodeURIComponent(name)));
  },
};
