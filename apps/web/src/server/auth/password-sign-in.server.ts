import { createAuthingAuthentication, type AuthingConfig } from "./authing-authentication.server";
import {
  signInThroughAuthing,
  type AuthingSignInResult,
  type SignInUseCaseInput,
} from "./authing-sign-in.server";

/**
 * Signs a person in with the account (email or username) and password they typed, through the sign-in every way of
 * signing in shares (`signInThroughAuthing`): counted against the limits first, checked by Authing,
 * then the session and the person's account.
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
        ...input.credentials,
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
