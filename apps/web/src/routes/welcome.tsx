import { createFileRoute, redirect } from "@tanstack/react-router";

import { getNameStep } from "#src/features/auth/first-sign-in.functions";
import { NameStepPage } from "#src/features/auth/name-step-page";
import { afterSignInHref, safeReturnTo } from "#src/features/auth/return-to";

/**
 * The one question of first sign-in: a person's display name. Outside the Workspace layout on
 * purpose: it is asked before their personal Workspace exists. Sign-in and every page that would
 * make or open that Workspace send a person here while they have no display name, with the page to go
 * on to as `returnTo`; someone who has one is sent straight on. Someone coming from a working
 * invite link is asked for the name only: joining is their way in, so no personal Workspace is made.
 */
export const Route = createFileRoute("/welcome")({
  // Only a page of this site is a place to go on to. The key is always returned, like `/login`.
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({
    returnTo: safeReturnTo(search.returnTo),
  }),
  beforeLoad: async ({ search }) => {
    const step = await getNameStep({ data: { returnTo: search.returnTo } });
    if (step.status === "named") throw redirect({ href: afterSignInHref(search.returnTo) });
    // The session outlived its user: nothing can be saved for them, so they sign in again (the
    // page asks even though the session still verifies), which makes the user and a new session.
    if (step.status === "account_gone") {
      throw redirect({ to: "/login", search: { returnTo: search.returnTo, prompt: "login" } });
    }
    return { prefill: step.prefill, slugPrefill: step.slugPrefill, invite: step.invite };
  },
  component: Welcome,
});

function Welcome() {
  const { prefill, slugPrefill, invite } = Route.useRouteContext();
  const { returnTo } = Route.useSearch();
  return (
    <NameStepPage prefill={prefill} slugPrefill={slugPrefill} invite={invite} returnTo={returnTo} />
  );
}
