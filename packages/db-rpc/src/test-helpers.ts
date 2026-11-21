import type { DbRpc } from "./types.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An RPC transport between a client and a server: arguments and results are structured-cloned
 * (as postMessage and Durable Object RPC do), calls may be delayed by random amounts (so they
 * arrive and complete out of order), and may be delivered twice (a retry). Every call and its
 * answer are recorded.
 */
export function transport(
  server: DbRpc,
  options: { maxDelay?: number; duplicate?: number; seed?: number } = {},
) {
  let x = options.seed ?? 7;
  const rnd = () => {
    x = (x * 1103515245 + 12345) >>> 0;
    return x / 2 ** 32;
  };
  const calls: { method: string; args: unknown[]; answer?: unknown }[] = [];
  const delay = () => sleep(Math.floor(rnd() * (options.maxDelay ?? 0)));
  const rpc = new Proxy({} as DbRpc, {
    get(_, method: string) {
      return async (...args: unknown[]) => {
        const record: { method: string; args: unknown[]; answer?: unknown } = { method, args };
        calls.push(record);
        const sent = structuredClone(args);
        await delay();
        // biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch in a test transport
        const call = () => (server as any)[method](...structuredClone(sent));
        if (rnd() < (options.duplicate ?? 0)) void call().catch(() => {});
        const result = await call();
        record.answer = result;
        await delay();
        return structuredClone(result);
      };
    },
  });
  return { rpc, calls };
}
