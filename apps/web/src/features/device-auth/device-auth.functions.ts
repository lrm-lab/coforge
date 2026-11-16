import { createServerFn } from "@tanstack/react-start";

import { authMiddleware } from "#src/features/auth/function-auth";
import { userCodeInputSchema } from "./device-auth.schemas";
import { approveUserCode, denyUserCode, lookupUserCode } from "#src/server/auth/device-auth.server";
import {
  deviceAuthorizationStore,
  externalAgentDeviceDeps,
} from "#src/server/auth/device-auth-store.server";
import type { ExternalGrantDetails } from "#src/server/auth/device-auth-external-agent.server";
import { signedInAccount } from "#src/server/auth/signed-in-account.server";
import { requireDatabaseClient } from "#src/server/db/client.server";

/**
 * The browser half of the device flow. Every one of these requires a signed-in user - the whole
 * point of the flow is that a Computer with no browser borrows the identity of someone who does
 * have one, so an unauthenticated caller must never be able to settle a grant.
 */

export type DeviceCodeState =
  | "ok"
  | "unknown"
  | "expired"
  | "settled"
  | "unavailable"
  | "not_authorized"
  | "agent_not_external"
  | "agent_unavailable";

/** Resolves the signed-in user for the approval page, redirecting to /login when there is none -
 * which is what makes "sign in first, then approve" a property of the route rather than an
 * instruction. Exposed as a feature server function, the way every other route reaches user
 * state, so a route file never imports a `#src/server/...` module directly. */
export const getDeviceVerifyUser = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { account } = await signedInAccount(requireDatabaseClient(), context.user);
    return { account };
  });

/** Checks a typed code without settling it, so the page can name what is about to be approved
 * before the user commits. Returns only whether the code is actionable - never who started it. */
export const checkDeviceCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(userCodeInputSchema)
  .handler(async ({ data }): Promise<{ state: DeviceCodeState; grant?: ExternalGrantDetails }> => {
    const store = deviceAuthorizationStore();
    if (!store) return { state: "unavailable" };
    const lookup = await lookupUserCode({
      store,
      userCode: data.userCode,
      directory: externalAgentDeviceDeps()?.directory,
    });
    if (!lookup.found) return { state: lookup.reason };
    return lookup.external ? { state: "ok", grant: lookup.external } : { state: "ok" };
  });

export const approveDeviceCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(userCodeInputSchema)
  .handler(async ({ data, context }): Promise<{ state: DeviceCodeState }> => {
    const user = context.user;
    const store = deviceAuthorizationStore();
    if (!store) return { state: "unavailable" };
    const result = await approveUserCode({
      store,
      userCode: data.userCode,
      userId: user.id,
      directory: externalAgentDeviceDeps()?.directory,
    });
    return { state: result.found ? "ok" : result.reason };
  });

export const denyDeviceCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(userCodeInputSchema)
  .handler(async ({ data }): Promise<{ state: DeviceCodeState }> => {
    const store = deviceAuthorizationStore();
    if (!store) return { state: "unavailable" };
    const result = await denyUserCode({
      store,
      userCode: data.userCode,
      directory: externalAgentDeviceDeps()?.directory,
    });
    return { state: result.found ? "ok" : result.reason };
  });
