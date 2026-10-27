import {
  CodeSendThrottledError,
  createAuthingAuthentication,
  type AuthingAuthentication,
  type AuthingConfig,
} from "./authing-authentication.server";
import {
  signInThroughAuthing,
  type AuthingSignInResult,
  type SignInUseCaseInput,
} from "./authing-sign-in.server";
import {
  reportCodeSendRateLimited,
  reportCodeSendThrottled,
  reportSignInFailure,
} from "./login-failure.server";
import { admitCodeSend, type CodeSendRateLimits } from "./sign-in-rate-limits.server";
import { codeDestinationKey, type CodeDestination } from "#src/features/auth/code-destination";

export type SendSignInCodeResult =
  /** The code is on its way. */
  | { status: "sent" }
  /** Too many codes asked for by this client address or for this destination, or Authing is
   * throttling it; nothing was sent. */
  | { status: "rate_limited" }
  /** Anything else went wrong, and was logged. */
  | { status: "send_failed" };

export type PasscodeSignInResult =
  | Exclude<AuthingSignInResult, { status: "invalid_credentials" }>
  /** Authing refused the code: wrong, expired, or already used. */
  | { status: "invalid_code" };

/**
 * Has Authing send a sign-in code to a phone number or an email. The request is first counted
 * against the limits (`rateLimits`, by `clientAddress` when the request has one, and by the
 * destination) and refused without calling Authing when one is exceeded; a code sent costs money
 * and reaches a stranger. Redis and the log only ever see the destination's hash, or nothing.
 */
export async function sendSignInCode(input: {
  config: AuthingConfig;
  destination: CodeDestination;
  rateLimits: CodeSendRateLimits;
  /** The client's address, counted against the address limit. */
  clientAddress?: string | undefined;
  authing?: AuthingAuthentication;
}): Promise<SendSignInCodeResult> {
  const authing = input.authing ?? createAuthingAuthentication(input.config);
  try {
    const admission = await admitCodeSend(input.rateLimits, {
      destination: codeDestinationKey(input.destination),
      clientAddress: input.clientAddress,
    });
    if (!admission.allowed) {
      reportCodeSendRateLimited(admission.limit);
      return { status: "rate_limited" };
    }
    await authing.sendSignInCode(input.destination);
    return { status: "sent" };
  } catch (error) {
    if (error instanceof CodeSendThrottledError) {
      reportCodeSendThrottled();
      return { status: "rate_limited" };
    }
    reportSignInFailure(error);
    return { status: "send_failed" };
  }
}

/**
 * Signs a person in with the code Authing sent to their phone number or email, through the
 * sign-in every way of signing in shares (`signInThroughAuthing`). The first code sign-in for a
 * destination makes the account (Authing's `autoRegister`), which then goes to the name step like
 * any new account. The attempt counts against the destination (`rateLimits`), so a code cannot be
 * guessed by trying them all.
 */
export async function signInWithPasscode(
  input: SignInUseCaseInput & {
    config: AuthingConfig;
    destination: CodeDestination;
    passCode: string;
  },
): Promise<PasscodeSignInResult> {
  const authing = input.authing ?? createAuthingAuthentication(input.config);
  const result = await signInThroughAuthing({
    stage: "passcode_sign_in",
    authenticate: (clientIp) =>
      authing.signInWithPasscode({
        destination: input.destination,
        passCode: input.passCode,
        ...(clientIp ? { clientIp } : {}),
      }),
    authing,
    sessionSecret: input.sessionSecret,
    secure: input.secure,
    account: codeDestinationKey(input.destination),
    rateLimits: input.rateLimits,
    clientAddress: input.clientAddress,
    resolveUser: input.resolveUser,
    now: input.now,
  });
  return result.status === "invalid_credentials" ? { status: "invalid_code" } : result;
}
