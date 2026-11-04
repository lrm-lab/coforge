/**
 * What a response used up in an Agent's context ledger, to give back when the response never
 * reached the Agent. The daemon builds the response, then the local proxy writes it to the CLI: only
 * the proxy can tell the write failed, so the claims travel on the response's own `messages` array
 * (never serialized) and the proxy takes them off it. `messages` may also hang directly on a
 * `Response` object — the forwarder attaches the elided array there when it rewrites a fetched
 * response body — so a `Response` is a valid claims carrier too.
 */
const claims = new WeakMap<object, () => void>();

export function holdClaims(messages: object, release: () => void): void {
  claims.set(messages, release);
}

/** The release for the claims `messages` carries, taken out so it can run only once. */
export function takeClaims(messages: unknown): (() => void) | undefined {
  if (!messages || typeof messages !== "object") return undefined;
  const release = claims.get(messages);
  claims.delete(messages);
  return release;
}
