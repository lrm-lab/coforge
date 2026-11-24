import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { z } from "zod";

import { ArtifactGalleryPage } from "#src/features/artifacts/artifact-gallery-page";
import { decodeArtifactShortId } from "#src/features/artifacts/artifact-short-id";
import { PageLoadError } from "#src/features/errors/page-load-error";

export const Route = createFileRoute("/w/$workspaceSlug/artifacts/")({
  validateSearch: z.object({
    artifact: z.string().min(1).optional().catch(undefined),
    version: z.coerce.number().int().positive().optional().catch(undefined),
    comment: z.uuid().optional().catch(undefined),
    review: z.uuid().optional().catch(undefined),
  }),
  ssr: "data-only",
  errorComponent: PageLoadError,
  component: ArtifactGalleryRoute,
});

function ArtifactGalleryRoute() {
  const { artifact, version, comment, review } = Route.useSearch();
  const navigate = Route.useNavigate();
  const arrival = useRouterState({ select: (state) => state.location.state.__TSR_key });
  const openArtifactId = artifact ? (decodeArtifactShortId(artifact) ?? undefined) : undefined;
  return (
    <ArtifactGalleryPage
      openArtifactId={openArtifactId}
      version={version}
      commentId={comment}
      reviewId={review}
      arrival={arrival}
      onCloseArtifact={() =>
        void navigate({
          search: (previous) => ({
            ...previous,
            artifact: undefined,
            version: undefined,
            comment: undefined,
            review: undefined,
          }),
          resetScroll: false,
        })
      }
      onClearReview={() =>
        void navigate({
          search: (previous) => ({ ...previous, review: undefined }),
          replace: true,
          resetScroll: false,
        })
      }
    />
  );
}
