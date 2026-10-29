import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { userRuntimeAuth } from "#src/server/computers/runtime-auth-composition.server";
import {
  readRuntimeAuthLogoutInputSchema,
  runtimeAuthLoginInputSchema,
  runtimeAuthLogoutInputSchema,
  runtimeAuthStatusReadInputSchema,
  startRuntimeAuthLoginInputSchema,
  submitRuntimeAuthCodeInputSchema,
} from "./runtime-auth.schemas";

/** Starts a runtime sign-in on a Computer; its progress reaches the caller on their own channel. */
export const startRuntimeAuthLogin = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(startRuntimeAuthLoginInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return userRuntimeAuth(db).startLogin({ userId: user.id, workspaceId }, data);
  });

export const submitRuntimeAuthCode = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(submitRuntimeAuthCodeInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return userRuntimeAuth(db).submitCode({ userId: user.id, workspaceId }, data);
  });

export const cancelRuntimeAuthLogin = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(runtimeAuthLoginInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return userRuntimeAuth(db).cancelLogin({ userId: user.id, workspaceId }, data);
  });

/**
 * Asks the Computer to read one runtime's login status again, as its page opens: it may have been
 * signed in or out on the Computer itself. The report arrives on the caller's own channel.
 */
export const requestRuntimeAuthStatus = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(runtimeAuthStatusReadInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return userRuntimeAuth(db).requestStatusRead({ userId: user.id, workspaceId }, data);
  });

/** The caller's login as it stands: what a page opened or reconnected mid-login missed. */
export const readRuntimeAuthLogin = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(runtimeAuthLoginInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return (await userRuntimeAuth(db).readLogin({ userId: user.id, workspaceId }, data)) ?? null;
  });

export const logoutRuntimeAuth = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(runtimeAuthLogoutInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return userRuntimeAuth(db).logout({ userId: user.id, workspaceId }, data);
  });

export const readRuntimeAuthLogout = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readRuntimeAuthLogoutInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return (await userRuntimeAuth(db).readLogout({ userId: user.id, workspaceId }, data)) ?? null;
  });
