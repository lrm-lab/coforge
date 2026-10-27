import { createFileRoute, redirect, useLocation } from "@tanstack/react-router";

import { getAuthenticationStatus } from "#src/features/auth/current-user.functions";
import { LoginPage } from "#src/features/auth/login-page";
import { readPasswordUpdated } from "#src/features/auth/password-updated";
import {
  afterSignInHref,
  readPrompt,
  readSignInError,
  safeReturnTo,
  type SignInError,
} from "#src/features/auth/return-to";
import { getSignInMethods } from "#src/features/auth/sign-in.functions";

/**
 * CoForge's own sign-in page. A person who already has a session goes straight on, unless the page
 * was asked to sign them in again (`prompt=login`: Login with CoForge needs a fresh sign-in, or the
 * session's user is gone).
 */
export const Route = createFileRoute("/login")({
  // The page to go back to after signing in; anything that is not a page of this site is dropped.
  // Both keys are always returned: the router keeps raw search keys a validator leaves out.
  validateSearch: (
    search: Record<string, unknown>,
  ): { returnTo?: string; prompt?: "login"; error?: SignInError } => ({
    returnTo: safeReturnTo(search.returnTo),
    prompt: readPrompt(search.prompt),
    // Why a sign-in that left the page (for GitHub) came back without completing.
    error: readSignInError(search.error),
  }),
  beforeLoad: async ({ search }) => {
    if (search.prompt !== "login" && (await getAuthenticationStatus())) {
      throw redirect({ href: afterSignInHref(search.returnTo) });
    }
  },
  loader: () => getSignInMethods(),
  component: Login,
});

function Login() {
  const { returnTo, prompt, error } = Route.useSearch();
  const { github } = Route.useLoaderData();
  const passwordUpdated = readPasswordUpdated(
    useLocation({ select: (location) => location.state }),
  );
  return (
    <LoginPage
      returnTo={returnTo}
      prompt={prompt}
      github={github}
      error={error}
      passwordUpdated={passwordUpdated}
    />
  );
}
