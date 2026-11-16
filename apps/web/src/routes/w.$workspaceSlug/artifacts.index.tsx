import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ArtifactGalleryPage } from "#src/features/artifacts/artifact-gallery-page";
import { artifactsOnQuery } from "#src/features/artifacts/artifact-queries";
import { NotFoundPage } from "#src/features/errors/not-found-page";

export const Route = createFileRoute("/w/$workspaceSlug/artifacts/")({
  ssr: "data-only",
  component: ArtifactGalleryRoute,
});

function ArtifactGalleryRoute() {
  const on = useQuery(artifactsOnQuery(useCurrentWorkspaceId()));
  if (on.isPending) return null;
  if (on.data === false) return <NotFoundPage />;
  return <ArtifactGalleryPage />;
}
