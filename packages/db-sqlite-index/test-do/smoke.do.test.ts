import { describe, expect, inject, it } from "vitest";
import { SCENARIOS } from "./scenarios.js";

const base = inject("doBaseUrl");

describe("vector and n-gram smoke scenarios on celld", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const id = crypto.randomUUID();
      const response = await fetch(`${base}/scenario/${id}/${encodeURIComponent(scenario.name)}`, {
        method: "POST",
      });
      const text = await response.text();
      let reply: unknown;
      try {
        reply = JSON.parse(text);
      } catch {
        throw new Error(`${response.status} ${text}`);
      }
      expect(reply).toEqual({ ok: true });
    });
  }
});
