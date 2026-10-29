import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import {
  isSignInCode,
  parseCodeDestination,
  typedDestination,
} from "#src/features/auth/code-destination";
import { isNewPassword } from "#src/features/auth/new-password";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  resetPasswordWithCode,
  sendPasswordResetCode,
} from "#src/server/auth/password-reset.server";
import {
  getCodeSendRateLimits,
  getResetCodeRateLimits,
} from "#src/server/auth/sign-in-rate-limits.server";
import { signInRequestContext } from "#src/server/auth/sign-in-request.server";

/**
 * Has Authing send the code that sets a new password to the phone number or email typed on the
 * reset page. A POST like every server function, so `createCsrfMiddleware` (`start.ts`) refuses a
 * call from another origin before this runs. `ok` whether or not an account has the destination:
 * the answer never says. `problem` is `invalid_destination` when it is neither a mainland China
 * mobile number nor an email, `rate_limited` when too many codes were asked for by the client's
 * address or for the destination, `send_failed` for anything else, which is logged.
 */
export const requestPasswordResetCode = createServerFn({ method: "POST" })
  .validator(z.object({ destination: typedDestination }))
  .handler(async ({ data }) => {
    declareNoStore();
    const destination = parseCodeDestination(data.destination);
    if (!destination) return { ok: false, problem: "invalid_destination" } as const;
    const { signIn, clientAddress } = await signInRequestContext(getRequest());
    if (!signIn) return { ok: false, problem: "send_failed" } as const;
    const result = await sendPasswordResetCode({
      config: signIn.config,
      destination,
      rateLimits: getCodeSendRateLimits(),
      clientAddress,
    });
    return result.status === "sent"
      ? ({ ok: true } as const)
      : ({ ok: false, problem: result.status } as const);
  });

/**
 * Sets a new password with the code sent to the phone number or email typed on the reset page; the
 * code is checked and the password set in this one call. Nobody is signed in and no cookie is set.
 * `problem` is `invalid_destination`, `invalid_code` or `invalid_password` when what was typed
 * cannot be a destination, a code or a password (or Authing refused the code), `password_refused`
 * when Authing's policy did not accept the password, `rate_limited` when too many attempts came
 * from the client's address or for the destination (Authing was not called), `failed` for
 * anything else, which is logged.
 */
export const resetPassword = createServerFn({ method: "POST" })
  .validator(
    z.object({
      destination: typedDestination,
      code: z.string().trim().max(32),
      password: z.string().max(1_024),
    }),
  )
  .handler(async ({ data }) => {
    declareNoStore();
    const destination = parseCodeDestination(data.destination);
    if (!destination) return { ok: false, problem: "invalid_destination" } as const;
    if (!isSignInCode(data.code)) return { ok: false, problem: "invalid_code" } as const;
    if (!isNewPassword(data.password)) return { ok: false, problem: "invalid_password" } as const;
    const { signIn, clientAddress } = await signInRequestContext(getRequest());
    if (!signIn) return { ok: false, problem: "failed" } as const;
    const result = await resetPasswordWithCode({
      config: signIn.config,
      destination,
      passCode: data.code,
      newPassword: data.password,
      rateLimits: getResetCodeRateLimits(),
      clientAddress,
    });
    return result.status === "updated"
      ? ({ ok: true } as const)
      : ({ ok: false, problem: result.status } as const);
  });
