import { createFileRoute, redirect } from "@tanstack/react-router";

import { getAuthenticationStatus } from "#src/features/auth/current-user.functions";
import { PasswordResetPage } from "#src/features/auth/password-reset-page";
import { afterSignInHref, readPrompt, safeReturnTo } from "#src/features/auth/return-to";

/**
 * Setting a new password with a code, reached from the password tab of `/login`. Outside
 * `/login`'s layout on purpose (`login_`): it is a page of its own. A person who already has a
 * session goes straight on, as from `/login`, unless the sign-in page was asked to sign them in
 * again (`prompt=login`): the reset belongs to that sign-in, so it stays and sends them back to it.
 */
export const Route = createFileRoute("/login_/reset-password")({
  // Only a page of this site is a place to go back to; the key is always returned, like `/login`.
  validateSearch: (search: Record<string, unknown>): { returnTo?: string; prompt?: "login" } => ({
    returnTo: safeReturnTo(search.returnTo),
    prompt: readPrompt(search.prompt),
  }),
  beforeLoad: async ({ search }) => {
    if (search.prompt !== "login" && (await getAuthenticationStatus())) {
      throw redirect({ href: afterSignInHref(search.returnTo) });
    }
  },
  component: PasswordReset,
});

function PasswordReset() {
  const { returnTo, prompt } = Route.useSearch();
  return <PasswordResetPage returnTo={returnTo} prompt={prompt} />;
}
