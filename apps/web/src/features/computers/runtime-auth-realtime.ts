import { publicationDataOrUndefined } from "#src/features/realtime/publication-data";
import type { RuntimeAuthSignal } from "#src/server/computers/runtime-auth.server";

/**
 * The one person's own channel for their runtime sign-in progress: the authorization link, the
 * device code and the result reach only the user who started the login. Every member who can see
 * a Computer is also told here that its login status changed, with nothing but its id. Its
 * namespace keeps no history, so none of that is stored in Centrifugo.
 */
export const runtimeAuthChannel = (userId: string) => `runtimeauth:user:${userId}`;

const SIGNAL_TYPES: Record<RuntimeAuthSignal["type"], true> = {
  "runtime-auth.login.v1": true,
  "runtime-auth.logout.v1": true,
  "runtime-auth.status.v1": true,
};

/** A publication on that channel, as JSON or its bytes; anything else is dropped. */
export function parseRuntimeAuthSignal(data: unknown): RuntimeAuthSignal | undefined {
  const value = publicationDataOrUndefined(data);
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && Object.hasOwn(SIGNAL_TYPES, type)
    ? (value as RuntimeAuthSignal)
    : undefined;
}
