import { parseCodeDestination } from "#src/features/auth/code-destination";
import { createAuthingAuthentication, type AuthingConfig } from "./authing-authentication.server";
import {
  signInThroughAuthing,
  type AuthingSignInResult,
  type SignInUseCaseInput,
} from "./authing-sign-in.server";

/**
 * Authing's PASSWORD connection stores mainland mobile numbers as 11 bare digits without `+86`.
 * Normalizes `+86...` / spaced phone inputs to the 11-digit number while leaving emails and
 * usernames unchanged.
 */
export function normalizePasswordAccount(account: string): string {
  const trimmed = account.trim();
  if (trimmed.includes("@")) return trimmed;
  const parsed = parseCodeDestination(trimmed);
  return parsed?.kind === "phone" ? parsed.phone : trimmed;
}

/**
 * Signs a person in with the account (email, username, or phone number) and password they typed,
 * through the sign-in every way of signing in shares (`signInThroughAuthing`): counted against
 * the limits first, checked by Authing, then the session and the person's account.
 * `invalid_credentials` is Authing refusing the account and password.
 */
export async function signInWithPassword(
  input: SignInUseCaseInput & {
    config: AuthingConfig;
    credentials: { account: string; password: string };
  },
): Promise<AuthingSignInResult> {
  const authing = input.authing ?? createAuthingAuthentication(input.config);
  return signInThroughAuthing({
    stage: "password_sign_in",
    authenticate: (clientIp) =>
      authing.signInWithPassword({
        account: normalizePasswordAccount(input.credentials.account),
        password: input.credentials.password,
        ...(clientIp ? { clientIp } : {}),
      }),
    authing,
    sessionSecret: input.sessionSecret,
    secure: input.secure,
    clientAddress: input.clientAddress,
    resolveUser: input.resolveUser,
    now: input.now,
  });
}
