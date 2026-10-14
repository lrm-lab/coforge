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
