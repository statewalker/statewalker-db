import type { Db, DbEntry } from "@statewalker/db-api";
import { runDbConformance } from "@statewalker/db-tests";
import { describe, expect, inject, it } from "vitest";
import { PROBE_EXPECTATIONS } from "./platform-probe.js";
import { SCENARIOS } from "./scenarios.js";

const base = inject("doBaseUrl");

async function post(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${response.status} ${text}`);
  }
}

/** A Db whose every call runs on newDoSqliteDb inside the DO named `id`. */
function remoteDb(id: string): Db {
  const call = async (op: string, sql?: string, params?: unknown[]) => {
    const reply = await post(`/db/${id}`, { op, sql, params });
    if (typeof reply.error === "string") throw new Error(reply.error);
    return reply;
  };
  return {
    query: async <T = DbEntry>(sql: string, params?: unknown[]) =>
      (await call("query", sql, params)).rows as T[],
    exec: async (sql: string) => {
      await call("exec", sql);
    },
    close: async () => {
      await call("close");
    },
  };
}

runDbConformance(async () => remoteDb(crypto.randomUUID()), {
  placeholder: "?",
  skipFilePersistence: true,
});

describe("scenarios on celld (transactions + registered smoke scenarios)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      expect(
        await post(`/scenario/${crypto.randomUUID()}/${encodeURIComponent(scenario.name)}`),
      ).toEqual({ ok: true });
    });
  }
});

describe("celld DO SQLite", () => {
  it("behaves as the fake assumes", async () => {
    const result = await post(`/probe/${crypto.randomUUID()}`);
    for (const [name, want] of Object.entries(PROBE_EXPECTATIONS)) {
      if (want === "ok") expect(result[name], name).toBe("ok");
      else expect(result[name], name).toMatch(want);
    }
  });
});
