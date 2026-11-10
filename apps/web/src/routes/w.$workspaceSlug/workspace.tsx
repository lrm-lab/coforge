import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceHub } from "#src/features/workspaces/workspace-hub";

export const Route = createFileRoute("/w/$workspaceSlug/workspace")({
  component: WorkspaceHub,
});
