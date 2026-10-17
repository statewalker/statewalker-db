import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    doBaseUrl: string;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no free port")),
      );
    });
  });

/** Start `celld dev` on test-do/ with a clean state; stop exactly that process afterwards. */
export default async function setup(project: TestProject) {
  const version = execFileSync("celld", ["--version"], { encoding: "utf8" }).trim();
  if (!/^celld 0\.6\./.test(version)) {
    throw new Error(
      `test:do needs celld 0.6.x on PATH, found "${version}" (curl -fsSL https://celld.dev/install.sh | sh)`,
    );
  }
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const port = await freePort();
  const child = spawn("celld", ["dev", dir, "--port", String(port), "--clean", "--no-watch"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`celld dev was not ready within 60 s:\n${log}`)),
      60_000,
    );
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the URL ends at an ANSI colour escape
      const ready = /ready\s+(http:\/\/[^\s\u001b]+)/.exec(log);
      if (ready?.[1]) {
        clearTimeout(timer);
        resolve(ready[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`celld dev exited (${code}) before it was ready:\n${log}`));
    });
  });
  project.provide("doBaseUrl", baseUrl);
  return () => {
    child.kill("SIGTERM");
  };
}
