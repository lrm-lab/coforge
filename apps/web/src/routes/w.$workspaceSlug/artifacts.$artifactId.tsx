import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ArtifactPage } from "#src/features/artifacts/artifact-page";
import { useArtifactsOn } from "#src/features/artifacts/artifact-queries";
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
  const on = useArtifactsOn();
  // Where artifacts are off, the page is not there.
  if (on === undefined) return null;
  if (!on) return <NotFoundPage />;
  return <ArtifactPage artifactId={artifactId} search={search} />;
}
