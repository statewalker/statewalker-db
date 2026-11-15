import type * as duckdb from "@duckdb/duckdb-wasm";
import { describe, expect, it, vi } from "vitest";
import { type DuckDbStartEnv, startDuckDb } from "./start-duckdb.js";

const bundle: duckdb.DuckDBBundle = {
  mainModule: "https://cdn.example/duckdb.wasm",
  mainWorker: "https://cdn.example/duckdb.worker.js",
  pthreadWorker: null,
};

interface FakeEngine {
  instantiate: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

/** A start environment of fakes: no Worker, no WASM, every call recorded. */
function fakeEnv(engine: Partial<FakeEngine> = {}) {
  const worker = { terminate: vi.fn() };
  const db: FakeEngine = {
    instantiate: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue({ conn: true }),
    terminate: vi.fn().mockResolvedValue(undefined),
    ...engine,
  };
  const env = {
    newWorker: vi.fn(() => worker as unknown as Worker),
    newDb: vi.fn(() => db as unknown as duckdb.AsyncDuckDB),
    createObjectURL: vi.fn(() => "blob:worker-shim"),
    revokeObjectURL: vi.fn(),
  } satisfies DuckDbStartEnv;
  return { env, worker, db };
}

describe("startDuckDb", () => {
  it("starts the jsDelivr worker through a Blob shim and revokes it once started", async () => {
    const { env, worker, db } = fakeEnv();
    const started = await startDuckDb(bundle, { selfHosted: false }, env);
    expect(env.newWorker).toHaveBeenCalledWith("blob:worker-shim");
    expect(env.revokeObjectURL).toHaveBeenCalledWith("blob:worker-shim");
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(started.conn).toEqual({ conn: true });
    expect(db.open).not.toHaveBeenCalled();
  });

  it("terminates the worker and revokes the Blob URL when instantiate rejects", async () => {
    const failure = new Error("jsDelivr unreachable");
    const { env, worker, db } = fakeEnv({ instantiate: vi.fn().mockRejectedValue(failure) });
    await expect(startDuckDb(bundle, { selfHosted: false }, env)).rejects.toBe(failure);
    expect(worker.terminate).toHaveBeenCalled();
    expect(db.terminate).toHaveBeenCalled();
    expect(env.revokeObjectURL).toHaveBeenCalledWith("blob:worker-shim");
  });

  it("terminates the worker and revokes the Blob URL when connect rejects", async () => {
    const failure = new Error("connect failed");
    const { env, worker, db } = fakeEnv({ connect: vi.fn().mockRejectedValue(failure) });
    await expect(startDuckDb(bundle, { selfHosted: false }, env)).rejects.toBe(failure);
    expect(worker.terminate).toHaveBeenCalled();
    expect(db.terminate).toHaveBeenCalled();
    expect(env.revokeObjectURL).toHaveBeenCalledWith("blob:worker-shim");
  });

  it("terminates a self-hosted worker when connect rejects, with no Blob URL to revoke", async () => {
    const failure = new Error("connect failed");
    const { env, worker } = fakeEnv({ connect: vi.fn().mockRejectedValue(failure) });
    await expect(startDuckDb(bundle, { selfHosted: true }, env)).rejects.toBe(failure);
    expect(env.newWorker).toHaveBeenCalledWith(bundle.mainWorker);
    expect(env.createObjectURL).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("keeps the original error when terminating the engine also fails", async () => {
    const failure = new Error("connect failed");
    const { env, worker } = fakeEnv({
      connect: vi.fn().mockRejectedValue(failure),
      terminate: vi.fn().mockRejectedValue(new Error("terminate failed")),
    });
    await expect(startDuckDb(bundle, { selfHosted: false }, env)).rejects.toBe(failure);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("wraps an open failure with the path and terminates the worker", async () => {
    const { env, worker } = fakeEnv({ open: vi.fn().mockRejectedValue(new Error("open failed")) });
    const start = startDuckDb(bundle, { selfHosted: true, path: "opfs://app.duckdb" }, env);
    await expect(start).rejects.toThrow('Cannot open DuckDB database "opfs://app.duckdb"');
    expect(worker.terminate).toHaveBeenCalled();
  });
});
