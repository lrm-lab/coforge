import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";
import type { AuthorizationRequest } from "./authorization-request.server";

/** How long a consent page may wait for an answer. */
const HANDLE_TTL_SECONDS = 30 * 60;

/** The request a consent page shows, bound to who it was shown to. */
type BoundAuthorization = {
  appId: string;
  userId: string;
  request: AuthorizationRequest;
  /** When CoForge asked the person to sign in again for this request (epoch seconds). */
  signInRequestedAt?: number;
};

type SealedAuthorization = BoundAuthorization & { exp: number };

/** The consent page's handle on `bound`: signed with the session secret, so the answer to the page
 * is about exactly this request, from this person, for the next 30 minutes. */
export function sealAuthorization(bound: BoundAuthorization, secret: string, now: Date): string {
  const sealed: SealedAuthorization = {
    ...bound,
    exp: Math.floor(now.getTime() / 1000) + HANDLE_TTL_SECONDS,
  };
  return signValue("authorization-request", sealed, secret);
}

/** The request `handle` binds, when the server signed it for `userId` and it has not expired. */
export function openAuthorization(
  handle: string,
  userId: string,
  secret: string,
  now: Date,
): BoundAuthorization | undefined {
  const sealed = readSignedValue<SealedAuthorization>("authorization-request", handle, secret);
  if (!sealed || sealed.userId !== userId || typeof sealed.exp !== "number") return undefined;
  if (sealed.exp * 1000 <= now.getTime()) return undefined;
  const { appId, request, signInRequestedAt } = sealed;
  return {
    appId,
    userId,
    request,
    ...(signInRequestedAt === undefined ? {} : { signInRequestedAt }),
  };
}
