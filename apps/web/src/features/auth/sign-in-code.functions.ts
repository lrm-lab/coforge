import { createServerFn } from "@tanstack/react-start";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import {
  isSignInCode,
  parseCodeDestination,
  typedDestination,
} from "#src/features/auth/code-destination";
import { nextHrefAfterSignIn } from "#src/features/auth/return-to";
import { declareNoStore } from "#src/features/no-store-response.server";
import { sendSignInCode, signInWithPasscode } from "#src/server/auth/passcode-sign-in.server";
import {
  getCodeSendRateLimits,
  getSignInRateLimits,
} from "#src/server/auth/sign-in-rate-limits.server";
import { signInRequestContext } from "#src/server/auth/sign-in-request.server";

/**
 * Has Authing send a sign-in code to the phone number or email typed on `/login`. A POST like
 * every server function, so `createCsrfMiddleware` (`start.ts`) refuses a call from another origin
 * before this runs. `problem` is `invalid_destination` when it is neither a mainland China mobile
 * number nor an email, `rate_limited` when too many codes were asked for by the client's address
 * or for the destination (or Authing is throttling it), `send_failed` for anything else, which is
 * logged.
 */
export const requestSignInCode = createServerFn({ method: "POST" })
  .validator(z.object({ destination: typedDestination }))
  .handler(async ({ data }) => {
    declareNoStore();
    const destination = parseCodeDestination(data.destination);
    if (!destination) return { ok: false, problem: "invalid_destination" } as const;
    const { signIn, clientAddress } = await signInRequestContext(getRequest());
    if (!signIn) return { ok: false, problem: "send_failed" } as const;
    const result = await sendSignInCode({
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
 * Signs in with the code sent to the phone number or email typed on `/login`; the first code
 * sign-in for a destination makes the account. Like `signInWithEmailPassword`, on success the
 * session cookie is on the response and `next` says where to go. `problem` is `invalid_destination`
 * or `invalid_code` when what was typed cannot be a destination or a code, or Authing refused the
 * code, `rate_limited` when too many attempts came from the client's address or for the
 * destination (Authing was not called), `failed` for anything else, which is logged.
 */
export const signInWithCode = createServerFn({ method: "POST" })
  .validator(
    z.object({
      destination: typedDestination,
      code: z.string().trim().max(32),
      returnTo: z.string().max(2_048).optional(),
    }),
  )
  .handler(async ({ data }) => {
    declareNoStore();
    const destination = parseCodeDestination(data.destination);
    if (!destination) return { ok: false, problem: "invalid_destination" } as const;
    if (!isSignInCode(data.code)) return { ok: false, problem: "invalid_code" } as const;
    const { signIn, secure, clientAddress } = await signInRequestContext(getRequest());
    if (!signIn) return { ok: false, problem: "failed" } as const;
    const result = await signInWithPasscode({
      ...signIn,
      secure,
      destination,
      passCode: data.code,
      rateLimits: getSignInRateLimits(),
      clientAddress,
    });
    if (result.status !== "signed_in") return { ok: false, problem: result.status } as const;
    appendResponseHeader("set-cookie", result.sessionCookie);
    return { ok: true, next: nextHrefAfterSignIn(result.welcomed, data.returnTo) } as const;
  });
