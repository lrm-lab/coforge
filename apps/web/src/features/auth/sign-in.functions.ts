import { createServerFn } from "@tanstack/react-start";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { nextHrefAfterSignIn } from "#src/features/auth/return-to";
import { declareNoStore } from "#src/features/no-store-response.server";
import { readGitHubSignInConfigOrNull } from "#src/server/auth/config.server";
import { signInWithPassword } from "#src/server/auth/password-sign-in.server";
import { signInRequestContext } from "#src/server/auth/sign-in-request.server";

/**
 * Signs in with the email and password typed on `/login`. A POST like every server function, so
 * `createCsrfMiddleware` (`start.ts`) refuses a call from another origin before this runs. On
 * success the session cookie is on the response and `next` says where to go: the name step for a
 * first sign-in, else `returnTo` (only ever a page of this site) or the start page. `problem`
 * is `invalid_credentials` when Authing refused the email and password, `rate_limited` when too
 * many attempts came from the client's address or for the email (Authing was not called), `failed`
 * for anything else, which is logged.
 */
export const signInWithEmailPassword = createServerFn({ method: "POST" })
  .validator(
    z.object({
      email: z.string().trim().min(1).max(320),
      password: z.string().min(1).max(1_024),
      returnTo: z.string().max(2_048).optional(),
    }),
  )
  .handler(async ({ data }) => {
    declareNoStore();
    const { signIn, secure, clientAddress } = await signInRequestContext(getRequest());
    if (!signIn) return { ok: false, problem: "failed" } as const;
    const result = await signInWithPassword({
      ...signIn,
      secure,
      credentials: { email: data.email, password: data.password },
      clientAddress,
    });
    if (result.status !== "signed_in") return { ok: false, problem: result.status } as const;
    appendResponseHeader("set-cookie", result.sessionCookie);
    return { ok: true, next: nextHrefAfterSignIn(result.welcomed, data.returnTo) } as const;
  });

/** Which ways of signing in `/login` offers beyond the code and the password: GitHub, when the
 * deployment configures it. */
export const getSignInMethods = createServerFn({ method: "GET" }).handler(() => {
  declareNoStore();
  return { github: readGitHubSignInConfigOrNull(process.env) !== null };
});
