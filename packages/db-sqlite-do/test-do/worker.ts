import { DurableObject } from "cloudflare:workers";
import { newDoSqliteDb } from "../src/index.js";
import { probeDoSqlite } from "./platform-probe.js";
import { SCENARIOS } from "./scenarios.js";

type Op = { op: "query" | "exec" | "close"; sql?: string; params?: unknown[] };
type Reply = Record<string, unknown>;
type Stub = {
  op(op: Op): Promise<Reply>;
  scenario(name: string): Promise<Reply>;
  probe(): Promise<Reply>;
};
type Env = { CONFORMANCE: { idFromName(name: string): unknown; get(id: unknown): Stub } };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One DO per test id: the Db conformance ops, the transaction scenarios and the platform probe. */
export class ConformanceDo extends DurableObject {
  db = newDoSqliteDb(this.ctx.storage);

  async op({ op, sql = "", params }: Op): Promise<Reply> {
    try {
      if (op === "query") return { rows: await this.db.query(sql, params) };
      if (op === "exec") await this.db.exec(sql);
      else await this.db.close();
      return {};
    } catch (error) {
      return { error: errorText(error) };
    }
  }

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

  async probe(): Promise<Reply> {
    return probeDoSqlite(this.ctx.storage);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, kind, id = "default", name = ""] = new URL(request.url).pathname.split("/");
    const stub = env.CONFORMANCE.get(env.CONFORMANCE.idFromName(id));
    if (kind === "db") return Response.json(await stub.op(await request.json()));
    if (kind === "scenario") return Response.json(await stub.scenario(decodeURIComponent(name)));
    if (kind === "probe") return Response.json(await stub.probe());
    return new Response("not found", { status: 404 });
  },
};
