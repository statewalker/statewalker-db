/**
 * db-rpc: a `Db` (`@statewalker/db-api`) over any RPC. The server serves a Db as plain calls; the
 * client is a Db over them. A result is cut into pages keyed by (streamId, pageId), so no message
 * has to hold a large one; calls carry keys, so a call delivered twice runs once. A read-only
 * server runs every call in a transaction that is always rolled back.
 */
export { type DbRpcClientOptions, newDbRpcClient } from "./client.js";
export { DbRpcError, errorCode } from "./errors.js";
export { type DbRpcServer, type DbRpcServerOptions, newDbRpcServer } from "./server.js";
export type {
  DbRpc,
  DbRpcErrorCode,
  QueryOptions,
  QueryPage,
  QueryResult,
  RequestOptions,
} from "./types.js";
