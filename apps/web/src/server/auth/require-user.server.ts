import { redirect } from "@tanstack/react-router";

import { readBrowserSignIn, type BrowserSignIn, type BrowserUser } from "./browser-login.server";
import { AuthConfigError, readSessionSecret } from "./config.server";
import { devBrowserUser } from "./dev-skip-auth.server";
import { safeReturnTo } from "#src/features/auth/return-to";
import { recordSignedInRequest } from "#src/server/observability/server-timing.server";

/**
 * The signed-in user, or a redirect to `/login`. `returnTo` is the page being opened; sign-in
 * brings the person back to it (a device-approval link keeps its code that way).
 */
export async function requireBrowserUser(
  cookieHeader: string | undefined,
  returnTo?: string,
): Promise<BrowserUser> {
  return (await requireBrowserSignIn(cookieHeader, returnTo)).user;
}

/** `requireBrowserUser`, with when the person signed in. The request counts as signed in for
 * Server-Timing (`recordSignedInRequest`); an optional read does not, since what it serves is
 * open to anyone. */
export async function requireBrowserSignIn(
  cookieHeader: string | undefined,
  returnTo?: string,
): Promise<BrowserSignIn> {
  const signIn = await readRequiredSignIn(cookieHeader, returnTo);
  recordSignedInRequest();
  return signIn;
}

async function readRequiredSignIn(
  cookieHeader: string | undefined,
  returnTo: string | undefined,
): Promise<BrowserSignIn> {
  const skipped = devSignIn();
  if (skipped) return skipped;

  let sessionSecret: string;
  try {
    sessionSecret = await readSessionSecret(process.env);
  } catch (error) {
    if (error instanceof AuthConfigError) throw redirect({ href: loginHref(returnTo) });
    throw error;
  }
  const signIn = readBrowserSignIn({ sessionSecret, cookieHeader: cookieHeader ?? "" });
  if (!signIn) throw redirect({ href: loginHref(returnTo) });
  return signIn;
}

function loginHref(returnTo: string | undefined): string {
  const page = safeReturnTo(returnTo);
  return page && page !== "/" ? `/login?returnTo=${encodeURIComponent(page)}` : "/login";
}

export async function optionalBrowserUser(
  cookieHeader: string | undefined,
): Promise<BrowserUser | null> {
  return (await optionalBrowserSignIn(cookieHeader))?.user ?? null;
}

/** `optionalBrowserUser`, with when the person signed in. */
export async function optionalBrowserSignIn(
  cookieHeader: string | undefined,
): Promise<BrowserSignIn | null> {
  const skipped = devSignIn();
  if (skipped) return skipped;

  try {
    return readBrowserSignIn({
      sessionSecret: await readSessionSecret(process.env),
      cookieHeader: cookieHeader ?? "",
    });
  } catch (error) {
    if (error instanceof AuthConfigError) return null;
    throw error;
  }
}

/** The dev user (`COFORGE_DEV_SKIP_AUTH`) never signed in, so counts as signing in now. */
function devSignIn(): BrowserSignIn | null {
  const user = devBrowserUser();
  return user ? { user, authTime: Math.floor(Date.now() / 1000) } : null;
}
