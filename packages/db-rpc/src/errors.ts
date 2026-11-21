import type { DbRpcErrorCode } from "./types.js";

/**
 * An error of the protocol itself. The code also leads the message (`UNKNOWN_STREAM: …`), since
 * a structured clone keeps an error's name and message but not its other properties:
 * `errorCode(e)` reads it back on the other side of a transport.
 */
export class DbRpcError extends Error {
  readonly code: DbRpcErrorCode;
  constructor(code: DbRpcErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DbRpcError";
    this.code = code;
  }
}

const CODES: ReadonlySet<string> = new Set<DbRpcErrorCode>([
  "UNKNOWN_STREAM",
  "TOO_MANY_STREAMS",
  "ABORTED",
  "INVALID",
]);
/** A message led by a code, as DbRpcError writes it (`CODE: …`). */
const LEADING_CODE = new RegExp(`^(${[...CODES].join("|")}):`);

/** The DbRpcError code of an error, also after it crossed a transport; undefined otherwise. */
export function errorCode(e: unknown): DbRpcErrorCode | undefined {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && CODES.has(code)) return code as DbRpcErrorCode;
  const m = LEADING_CODE.exec(String((e as Error)?.message ?? ""));
  return m?.[1] as DbRpcErrorCode | undefined;
}
