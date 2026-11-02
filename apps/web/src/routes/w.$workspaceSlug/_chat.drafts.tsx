import { createFileRoute } from "@tanstack/react-router";

import { DraftsView } from "#src/features/conversations/drafts-view";

// The Drafts view lives in the Chat detail pane; the parent layout owns the directory around it.
export const Route = createFileRoute("/w/$workspaceSlug/_chat/drafts")({
  component: DraftsView,
});
