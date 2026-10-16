/**
 * The text of a caught value: an `Error`'s `message`, otherwise `String(value)`.
 *
 * The `error instanceof Error ? error.message : String(error)` ternary was copied inline across
 * the agent, coforge, computer and daemon packages. This differs from the daemon's
 * `code-agent/json-record.ts` `errorMessage`, which returns `""` for a non-`Error` on purpose.
 */
export function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The readable text of a thrown value. A Centrifugo RPC rejection is a plain
 * `{ code, message }` object, so `String(error)` would be `[object Object]`. */
export function refusalText(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return message;
  }
  return thrownMessage(error);
}
