import {
  InvalidCredentialsError,
  type AuthingAuthentication,
  type AuthingTokens,
  type SignInStage,
} from "./authing-authentication.server";
import { completeBrowserLogin, type InternalUserResolver } from "./browser-login.server";
import {
  atSignInStage,
  reportSignInFailure,
  reportSignInRejected,
  reportTokenRevocationFailure,
  SignInFailure,
} from "./login-failure.server";
import { UserIdentityRepository } from "./user-identity.repository.server";
import { getDatabaseClient } from "#src/server/db/client.server";

/** What every way of signing in is given besides what the person typed (`signInThroughAuthing`
 * takes the rest from it). */
export type SignInUseCaseInput = {
  sessionSecret: string;
  /** Whether the browser reached the site over HTTPS, which the session cookie follows. */
  secure: boolean;
  /** The client's address, passed on to Authing. */
  clientAddress?: string | undefined;
  authing?: AuthingAuthentication;
  resolveUser?: InternalUserResolver;
  now?: () => number;
};

export type AuthingSignInResult =
  | {
      status: "signed_in";
      sessionCookie: string;
      /** Whether the person finished first sign-in; when not, the name step comes next. */
      welcomed: boolean;
    }
  /** Authing refused what the person typed (the password, or the code), or the GitHub code. */
  | { status: "invalid_credentials" }
  /** Anything else went wrong, and was logged; nothing the person typed was at fault. */
  | { status: "failed" };

/**
 * The sign-in every way of proving who you are shares. There is no attempt limit on it: a lockout
 * costs a person their account and an attacker nothing they cannot spend elsewhere (Frank,
 * 2026-10-29). `authenticate` has Authing check what the person typed, and the session and the person's account follow (`completeBrowserLogin`); Authing's
 * token is then revoked in the background, whatever became of the sign-in. A refusal and a failure are results, not exceptions, so the caller shows
 * each its own message; a failure is logged here, with the step it stopped at and without anything
 * the person typed.
 */
export async function signInThroughAuthing(input: {
  /** The step `authenticate` is, which names its failures in the log. */
  stage: SignInStage;
  authenticate: (clientIp: string | undefined) => Promise<AuthingTokens>;
  authing: AuthingAuthentication;
  sessionSecret: string;
  secure: boolean;
  /** The client's address, passed on to Authing and counted against the address limit. */
  clientAddress?: string | undefined;
  resolveUser?: InternalUserResolver | undefined;
  now?: (() => number) | undefined;
}): Promise<AuthingSignInResult> {
  const { authing } = input;
  try {
    const tokens = await atSignInStage(input.stage, () => input.authenticate(input.clientAddress));
    // CoForge keeps its own session, so Authing's token is done with once the profile is read:
    // revoking it then leaves no bearer token behind in a cookie or anywhere else. Every way out of
    // here revokes it, the person's account failing to resolve included, and nobody waits for it.
    let completed: Awaited<ReturnType<typeof completeBrowserLogin>>;
    try {
      completed = await completeBrowserLogin({
        sessionSecret: input.sessionSecret,
        tokens,
        authing,
        secure: input.secure,
        resolveUser: input.resolveUser ?? persistedIdentityResolver(),
        ...(input.now ? { now: input.now } : {}),
      });
    } finally {
      revokeInBackground(authing, tokens.accessToken);
    }
    return {
      status: "signed_in",
      sessionCookie: completed.sessionCookie,
      welcomed: completed.welcomed,
    };
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      reportSignInRejected(error);
      return { status: "invalid_credentials" };
    }
    reportSignInFailure(error);
    return { status: "failed" };
  }
}

/** Has Authing revoke `token` without the caller waiting; a failure is logged, and the token
 * expires on its own. */
function revokeInBackground(authing: AuthingAuthentication, token: string): void {
  void (async () => authing.revokeToken(token))().catch(reportTokenRevocationFailure);
}

function persistedIdentityResolver(): InternalUserResolver {
  const db = getDatabaseClient();
  if (!db) throw new SignInFailure("user_resolution", { reason: "database is unavailable" });
  const identities = new UserIdentityRepository(db);
  return (identity) =>
    identities.resolve(identity.provider, identity.subject, {
      email: identity.email,
      emailVerified: identity.emailVerified,
      phone: identity.phone,
      phoneVerified: identity.phoneVerified,
      preferredUsername: identity.preferredUsername,
      name: identity.name,
      nickname: identity.nickname,
    });
}
