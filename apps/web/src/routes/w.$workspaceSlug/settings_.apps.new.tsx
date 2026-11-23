import { createFileRoute, notFound } from "@tanstack/react-router";

import { AppEditorPage } from "#src/features/apps/app-editor-page";
import { loadWorkspaceApps } from "#src/features/apps/apps.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { loadWorkspaceMembers } from "#src/features/workspaces/members.functions";
import { canManageApps } from "#src/features/workspaces/workspace-roles";

export const Route = createFileRoute("/w/$workspaceSlug/settings_/apps/new")({
  loader: async () => {
    const [loaded, members] = await Promise.all([loadWorkspaceApps(), loadWorkspaceMembers()]);
    if (!canManageApps(members.actorRole)) throw notFound();
    return loaded;
  },
  errorComponent: PageLoadError,
  component: NewAppRoute,
});

function NewAppRoute() {
  const { apps, declares } = Route.useLoaderData();
  return <AppEditorPage initialApps={apps} initialDeclares={declares} />;
}
