import { createFileRoute } from "@tanstack/react-router";

import { MePage } from "#src/features/profiles/me-page";

export const Route = createFileRoute("/w/$workspaceSlug/me")({
  component: MePage,
});
