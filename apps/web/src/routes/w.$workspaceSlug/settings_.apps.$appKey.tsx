import { createFileRoute, notFound } from "@tanstack/react-router";

import { AppEditorPage } from "#src/features/apps/app-editor-page";
import { loadWorkspaceApps } from "#src/features/apps/apps.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { loadWorkspaceMembers } from "#src/features/workspaces/members.functions";
import { canManageApps } from "#src/features/workspaces/workspace-roles";

export const Route = createFileRoute("/w/$workspaceSlug/settings_/apps/$appKey")({
  loader: async ({ params }) => {
    const [loaded, members] = await Promise.all([loadWorkspaceApps(), loadWorkspaceMembers()]);
    if (!canManageApps(members.actorRole)) throw notFound();
    const target = loaded.apps.find((app) => app.key === params.appKey && app.owned);
    if (!target) throw notFound();
    return loaded;
  },
  errorComponent: PageLoadError,
  component: EditAppRoute,
});

function EditAppRoute() {
  const { appKey } = Route.useParams();
  const { apps, declares } = Route.useLoaderData();
  return (
    <AppEditorPage key={appKey} appKey={appKey} initialApps={apps} initialDeclares={declares} />
  );
}
