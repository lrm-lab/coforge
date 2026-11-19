import { createServerFn } from "@tanstack/react-start";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { nextHrefAfterSignIn } from "#src/features/auth/return-to";
import { declareNoStore } from "#src/features/no-store-response.server";
import { signInMethods } from "#src/server/auth/config.server";
import { signInWithPassword } from "#src/server/auth/password-sign-in.server";
import { signInRequestContext } from "#src/server/auth/sign-in-request.server";

export const signInWithAccountPassword = createServerFn({ method: "POST" })
  .validator(
    z.object({
      account: z.string().trim().min(1).max(320),
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
      credentials: { account: data.account, password: data.password },
      clientAddress,
    });
    if (result.status !== "signed_in") return { ok: false, problem: result.status } as const;
    appendResponseHeader("set-cookie", result.sessionCookie);
    return {
      ok: true,
      next: nextHrefAfterSignIn(result.welcomed, data.returnTo),
      welcomed: result.welcomed,
    } as const;
  });

export const getSignInMethods = createServerFn({ method: "GET" }).handler(() => {
  declareNoStore();
  return signInMethods(process.env);
});
