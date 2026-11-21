import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { newFakeDoStorage } from "@statewalker/db-sqlite-do/fake";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { runDbConformance } from "@statewalker/db-tests";
import { describe } from "vitest";
import { newDbRpcClient, newDbRpcServer } from "./index.js";
import { transport } from "./test-helpers.js";

// The shared Db suite on the client, over a server on Durable Object SQLite (the node:sqlite fake).
describe("over db-sqlite-do, called directly", () => {
  runDbConformance(
    async () => newDbRpcClient({ rpc: newDbRpcServer({ db: newDoSqliteDb(newFakeDoStorage()) }) }),
    { placeholder: "?", skipFilePersistence: true },
  );
});

describe("over db-sqlite-do, through a transport that clones, reorders and repeats calls", () => {
  let seed = 1;
  runDbConformance(
    async () => {
      const server = newDbRpcServer({ db: newDoSqliteDb(newFakeDoStorage()), pageRows: 1 });
      const { rpc } = transport(server, { maxDelay: 3, duplicate: 0.5, seed: seed++ });
      return newDbRpcClient({ rpc });
    },
    { placeholder: "?", skipFilePersistence: true },
  );
});

// File persistence needs a file-backed Db: db-sqlite-node, opened per path.
describe("over db-sqlite-node", () => {
  runDbConformance(
    async (options) =>
      newDbRpcClient({ rpc: newDbRpcServer({ db: await newNodeSqliteDb(options) }) }),
    { placeholder: "?" },
  );
});
