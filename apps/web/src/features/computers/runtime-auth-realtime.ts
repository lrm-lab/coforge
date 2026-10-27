import type { RuntimeAuthSignal } from "#src/server/computers/runtime-auth.server";

/**
 * The one person's own channel for their runtime sign-in progress: the authorization link, the
 * device code and the result reach only the user who started the login. Every member who can see
 * a Computer is also told here that its login status changed, with nothing but its id. Its
 * namespace keeps no history, so none of that is stored in Centrifugo.
 */
export const runtimeAuthChannel = (userId: string) => `runtimeauth:user:${userId}`;

const SIGNAL_TYPES: ReadonlySet<unknown> = new Set<RuntimeAuthSignal["type"]>([
  "runtime-auth.login.v1",
  "runtime-auth.logout.v1",
  "runtime-auth.status.v1",
]);
const decoder = new TextDecoder();

/** A publication on that channel, as JSON or its bytes; anything else is dropped. */
export function parseRuntimeAuthSignal(data: unknown): RuntimeAuthSignal | undefined {
  try {
    const value: unknown = data instanceof Uint8Array ? JSON.parse(decoder.decode(data)) : data;
    if (typeof value !== "object" || value === null) return undefined;
    return SIGNAL_TYPES.has((value as { type?: unknown }).type)
      ? (value as RuntimeAuthSignal)
      : undefined;
  } catch {
    return undefined;
  }
}
