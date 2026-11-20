import { createFileRoute } from "@tanstack/react-router";

import { ArtifactGalleryPage } from "#src/features/artifacts/artifact-gallery-page";
import { PageLoadError } from "#src/features/errors/page-load-error";

export const Route = createFileRoute("/w/$workspaceSlug/artifacts/")({
  ssr: "data-only",
  errorComponent: PageLoadError,
  component: ArtifactGalleryRoute,
});

function ArtifactGalleryRoute() {
  return <ArtifactGalleryPage />;
}
