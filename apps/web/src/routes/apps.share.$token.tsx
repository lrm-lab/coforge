import { createFileRoute, redirect } from "@tanstack/react-router";

import { loadSharedApp } from "#src/features/apps/shared-app.functions";
import { SharedAppPage } from "#src/features/apps/shared-app-page";
import { getSignedInAccount } from "#src/features/auth/current-user.functions";
import { nameStepRedirect } from "#src/features/auth/name-step-redirect";
import { isAppErrorCode } from "#src/lib/app-error";

/**
 * A private app share link. Outside the Workspace layout on purpose: the person may be in several
 * Workspaces and chooses one on the page. Signed out they sign in and come back; a link that is
 * unknown, revoked or expired loads as `shared: null`.
 */
export const Route = createFileRoute("/apps/share/$token")({
  loader: async ({ params, location }) => {
    const viewer = await getSignedInAccount();
    if (viewer === null) throw redirect({ to: "/login", search: { returnTo: location.href } });
    if (!viewer.named) throw nameStepRedirect(location.href);
    const shared = await loadSharedApp({ data: { token: params.token } }).catch(
      (error: unknown) => {
        if (isAppErrorCode(error, "NOT_FOUND")) return null;
        throw error;
      },
    );
    return { shared };
  },
  // Whether the link still works must never come from a cache.
  staleTime: 0,
  gcTime: 0,
  component: SharedApp,
});

function SharedApp() {
  const { token } = Route.useParams();
  const { shared } = Route.useLoaderData();
  return <SharedAppPage key={token} token={token} shared={shared} />;
}
