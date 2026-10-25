/**
 * The one "is this a JSON record" test: a non-null object that is not an array.
 *
 * The `!Array.isArray` half is the part worth naming. An array *is* an object, so a reader that
 * forgets it happily treats `[]` as a record and then reads named fields off it — which is why the
 * daemon's HTTP wire validation and the web RPC handler's payload readers both spell the clause out.
 *
 * The record-returning forms in Anvil `src/json-record.ts` and Web's
 * `src/server/centrifugo/rpc-handler.server.ts` delegate here, so only the answer shape differs
 * between callers. Daemon `agent-http-wire.ts` uses the predicate directly.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
