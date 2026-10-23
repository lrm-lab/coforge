import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { getSignedInAccount } from "#src/features/auth/current-user.functions";
import { nameStepRedirect } from "#src/features/auth/name-step-redirect";
import { localizedReturnHref, safeReturnTo } from "#src/features/auth/return-to";
import { getGitHubConnection } from "#src/features/integrations/github.functions";
import { githubStepHref, githubStepPlan } from "#src/features/onboarding/github-step";
import { GitHubStepPage } from "#src/features/onboarding/github-step-page";
import { openWorkspace } from "#src/features/workspaces/workspaces.functions";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { isAppError } from "#src/lib/app-error";

/**
 * The "Connect GitHub" step right after a Workspace is created. Outside the Workspace layout (no
 * sidebar), like `/welcome`; membership is checked here, as the layout does. When GitHub is not
 * configured or the viewer is connected it never shows: the visit goes straight on to `next`.
 */
export const Route = createFileRoute("/w/$workspaceSlug_/connect-github")({
  // Only a page of this site is a place to go on to.
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: safeReturnTo(search.next),
  }),
  beforeLoad: async ({ params, search, location }) => {
    if (!isValidWorkspaceSlug(params.workspaceSlug)) throw notFound();
    const viewer = await getSignedInAccount();
    if (viewer === null) throw redirect({ to: "/login", search: { returnTo: location.href } });
    // Their answer titles their Workspace: the name step comes first, as for the other pages here.
    if (!viewer.named) throw nameStepRedirect(location.href);
    // A Workspace the viewer is not in is a page that does not exist for them.
    const opened = await openWorkspace().catch((error: unknown) => {
      if (isAppError(error) && error.code === "NOT_FOUND") throw notFound();
      throw error;
    });
    // A former slug names the same Workspace under its current one.
    if (opened.slug !== params.workspaceSlug)
      throw redirect({
        href: localizedReturnHref(githubStepHref(opened.slug, search.next)),
        replace: true,
      });
    // GitHub being unreachable must not block entry into the new Workspace: no answer, no question.
    const status = await getGitHubConnection().then(
      (connection) => connection.status,
      () => "unconfigured" as const,
    );
    const plan = githubStepPlan({ status, slug: opened.slug, next: search.next });
    if (plan.kind === "skip") throw redirect({ href: localizedReturnHref(plan.href) });
    return { action: plan.action, next: plan.next };
  },
  component: ConnectGitHub,
});

function ConnectGitHub() {
  const { action, next } = Route.useRouteContext();
  return <GitHubStepPage action={action} next={next} />;
}
