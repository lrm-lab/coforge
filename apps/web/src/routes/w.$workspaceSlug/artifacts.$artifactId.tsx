import { createFileRoute } from "@tanstack/react-router";

import { ArtifactPage } from "#src/features/artifacts/artifact-page";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { artifactsOnQuery } from "#src/features/artifacts/artifact-queries";
import { NotFoundPage } from "#src/features/errors/not-found-page";

export const Route = createFileRoute("/w/$workspaceSlug/artifacts/$artifactId")({
  ssr: "data-only",
  component: ArtifactRoutePage,
});

function ArtifactRoutePage() {
  const { artifactId } = Route.useParams();
  const on = useQuery(artifactsOnQuery(useCurrentWorkspaceId()));
  if (on.isPending) return null;
  if (on.data === false) return <NotFoundPage />;
  return <ArtifactPage artifactId={artifactId} />;
}
