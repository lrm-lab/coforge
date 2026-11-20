import { createFileRoute, notFound, useRouterState } from "@tanstack/react-router";
import { z } from "zod";

import { ArtifactPage } from "#src/features/artifacts/artifact-page";
import { clearReviewSearch } from "#src/features/artifacts/artifact-search";
import { decodeArtifactShortId } from "#src/features/artifacts/artifact-short-id";
import { NotFoundPage } from "#src/features/errors/not-found-page";
import { PageLoadError } from "#src/features/errors/page-load-error";

export const Route = createFileRoute("/w/$workspaceSlug/artifacts/$artifactId")({
  ssr: "data-only",
  staticData: { standalone: true },
  validateSearch: z.object({
    review: z.uuid().optional().catch(undefined),
    comment: z.uuid().optional().catch(undefined),
    version: z.coerce.number().int().positive().optional().catch(undefined),
  }),
  beforeLoad: ({ params }) => {
    const artifactId = decodeArtifactShortId(params.artifactId);
    if (!artifactId) throw notFound();
    return { artifactId };
  },
  errorComponent: PageLoadError,
  notFoundComponent: NotFoundPage,
  component: ArtifactRoutePage,
});

function ArtifactRoutePage() {
  const { artifactId } = Route.useRouteContext();
  const { review, comment, version } = Route.useSearch();
  const navigate = Route.useNavigate();
  const arrival = useRouterState({ select: (state) => state.location.state.__TSR_key });
  return (
    <ArtifactPage
      artifactId={artifactId}
      reviewId={review}
      commentId={comment}
      version={version}
      arrival={arrival}
      onClearReview={() =>
        void navigate({ search: clearReviewSearch, replace: true, resetScroll: false })
      }
    />
  );
}
