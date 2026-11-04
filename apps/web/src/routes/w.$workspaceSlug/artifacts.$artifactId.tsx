import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ArtifactPage } from "#src/features/artifacts/artifact-page";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { artifactsOnQuery } from "#src/features/artifacts/artifact-queries";
import { artifactPageSearchShape } from "#src/features/artifacts/artifact-search";
import { NotFoundPage } from "#src/features/errors/not-found-page";

/** An artifact's own page (task #514): a document to edit or a web page to look at. */
export const Route = createFileRoute("/w/$workspaceSlug/artifacts/$artifactId")({
  // The document editor (TipTap) renders in the browser only.
  ssr: "data-only",
  validateSearch: z.object(artifactPageSearchShape),
  component: ArtifactRoutePage,
});

function ArtifactRoutePage() {
  const { artifactId } = Route.useParams();
  const search = Route.useSearch();
  const on = useQuery(artifactsOnQuery(useCurrentWorkspaceId()));
  // Where artifacts are off, the page is not there. Whether they are, unknown for a failed read,
  // is the page's own reads to say: they are refused where artifacts are off.
  if (on.isPending) return null;
  if (on.data === false) return <NotFoundPage />;
  return <ArtifactPage artifactId={artifactId} search={search} />;
}
