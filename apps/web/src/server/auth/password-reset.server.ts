import {
  CodeSendRefusedError,
  CodeSendThrottledError,
  createAuthingAuthentication,
  PasswordResetRefusedError,
  type AuthingAuthentication,
  type AuthingConfig,
} from "./authing-authentication.server";
import {
  reportCodeSendRateLimited,
  reportPasswordResetCodeNotSent,
  reportPasswordResetRejected,
  reportSignInFailure,
  reportSignInRateLimited,
} from "./login-failure.server";
import {
  admitCodeSend,
  admitSignIn,
  type CodeSendRateLimits,
  type SignInRateLimits,
} from "./sign-in-rate-limits.server";
import { codeDestinationKey, type CodeDestination } from "#src/features/auth/code-destination";

export type SendPasswordResetCodeResult =
  /** What the person is told whether or not a code was sent: an account that does not have the
   * destination, and one Authing is already sending to, look the same as one it sent to. */
  | { status: "sent" }
  /** Too many codes asked for by this client address or for this destination; nothing was sent. */
  | { status: "rate_limited" }
  /** Authing could not be asked, and the failure was logged. */
  | { status: "send_failed" };

export type ResetPasswordResult =
  | { status: "updated" }
  /** Too many attempts from this client address or for this destination; Authing was not called. */
  | { status: "rate_limited" }
  /** Authing refused the code: wrong, expired, already used, or for no account. */
  | { status: "invalid_code" }
  /** Authing accepted the code but not the password. The code is spent. */
  | { status: "password_refused" }
  /** Anything else went wrong, and was logged. */
  | { status: "failed" };

/**
 * Has Authing send the code that sets a new password to a phone number or an email. Counted
 * against the same limits as a sign-in code (`admitCodeSend`). A request is answered `sent`
 * whatever Authing says about the destination: it refuses one no account has, and that must not
 * show, so a refusal and its own throttle are logged without the destination and not reported.
 */
export async function sendPasswordResetCode(input: {
  config: AuthingConfig;
  destination: CodeDestination;
  rateLimits: CodeSendRateLimits;
  /** The client's address, counted against the address limit. */
  clientAddress?: string | undefined;
  authing?: AuthingAuthentication;
}): Promise<SendPasswordResetCodeResult> {
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
    await authing.sendResetCode(input.destination);
  } catch (error) {
    if (error instanceof CodeSendRefusedError) {
      reportPasswordResetCodeNotSent("refused", error.providerError);
    } else if (error instanceof CodeSendThrottledError) {
      reportPasswordResetCodeNotSent("throttled", error.providerError);
    } else {
      reportSignInFailure(error);
      return { status: "send_failed" };
    }
  }
  return { status: "sent" };
}

/**
 * Sets a new password with the code Authing sent: the code is checked and the password set in this
 * one call, so the token between the two never leaves the server. The attempt counts against the
 * destination (`rateLimits`), so a code cannot be guessed by trying them all. Nobody is signed in
 * by it, and no session is made.
 */
export async function resetPasswordWithCode(input: {
  config: AuthingConfig;
  destination: CodeDestination;
  passCode: string;
  newPassword: string;
  rateLimits: SignInRateLimits;
  /** The client's address, counted against the address limit. */
  clientAddress?: string | undefined;
  authing?: AuthingAuthentication;
}): Promise<ResetPasswordResult> {
  const authing = input.authing ?? createAuthingAuthentication(input.config);
  try {
    const admission = await admitSignIn(input.rateLimits, {
      account: codeDestinationKey(input.destination),
      clientAddress: input.clientAddress,
    });
    if (!admission.allowed) {
      reportSignInRateLimited(admission.limit);
      return { status: "rate_limited" };
    }
    const resetToken = await authing.verifyResetCode({
      destination: input.destination,
      passCode: input.passCode,
    });
    await authing.resetPassword({ resetToken, password: input.newPassword });
    return { status: "updated" };
  } catch (error) {
    if (error instanceof PasswordResetRefusedError) {
      reportPasswordResetRejected(error);
      return { status: error.refused === "reset_code" ? "invalid_code" : "password_refused" };
    }
    reportSignInFailure(error);
    return { status: "failed" };
  }
}
