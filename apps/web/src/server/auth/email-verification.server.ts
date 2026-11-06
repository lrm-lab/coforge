import {
  CodeSendThrottledError,
  createAuthingAuthentication,
  type AuthingAuthentication,
  type AuthingConfig,
} from "./authing-authentication.server";
import {
  reportCodeSendThrottled,
  reportSignInFailure,
  reportVerifyEmailRateLimited,
} from "./login-failure.server";
import { admitVerifyEmailSend, type VerifyEmailRateLimits } from "./sign-in-rate-limits.server";

export type EmailVerificationResult =
  /** The link is on its way to the account's own address. */
  | { status: "sent" }
  /** The provider already vouches for the address; nothing was sent. */
  | { status: "already_verified" }
  /** The account carries no address to send to. */
  | { status: "no_email" }
  /** The per-user send limit refused it, or Authing is throttling it; nothing was sent. */
  | { status: "rate_limited" }
  /** Anything else went wrong, and was logged. */
  | { status: "failed" };

/**
 * Has Authing send the signed-in account's own address a link that verifies it. The destination
 * is always the address the account already carries — never one the caller names — and only a
 * provider-confirmed webhook (`user:email-verified`) ever sets `emailVerified`. The send is
 * counted against the per-user limit (`rateLimits`) before Authing is called.
 */
export async function requestEmailVerification(input: {
  /** The account's stored email and whether the provider verified it (`null` until it has said). */
  profile: { email: string | null; emailVerified: boolean | null };
  /** The signed-in user, counted against the per-user send limit. */
  userId: string;
  config: AuthingConfig;
  rateLimits: VerifyEmailRateLimits;
  authing?: AuthingAuthentication;
}): Promise<EmailVerificationResult> {
  if (input.profile.emailVerified === true) return { status: "already_verified" };
  const email = input.profile.email?.trim();
  if (!email) return { status: "no_email" };
  const authing = input.authing ?? createAuthingAuthentication(input.config);
  try {
    const admission = await admitVerifyEmailSend(input.rateLimits, input.userId);
    if (!admission.allowed) {
      reportVerifyEmailRateLimited();
      return { status: "rate_limited" };
    }
    await authing.sendVerifyEmailLink(email);
    return { status: "sent" };
  } catch (error) {
    if (error instanceof CodeSendThrottledError) {
      reportCodeSendThrottled();
      return { status: "rate_limited" };
    }
    reportSignInFailure(error);
    return { status: "failed" };
  }
}
