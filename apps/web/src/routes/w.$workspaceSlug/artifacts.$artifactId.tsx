import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { z } from "zod";

import { ArtifactPage } from "#src/features/artifacts/artifact-page";
import { clearReviewSearch } from "#src/features/artifacts/artifact-search";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { artifactsOnQuery } from "#src/features/artifacts/artifact-queries";
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
  errorComponent: PageLoadError,
  component: ArtifactRoutePage,
});

function ArtifactRoutePage() {
  const { artifactId: rawArtifactId } = Route.useParams();
  const artifactId = decodeArtifactShortId(rawArtifactId);
  const { review, comment, version } = Route.useSearch();
  const navigate = Route.useNavigate();
  const arrival = useRouterState({ select: (state) => state.location.state.__TSR_key });
  const on = useQuery(artifactsOnQuery(useCurrentWorkspaceId()));
  if (on.isPending) return null;
  if (on.data === false || artifactId === null) return <NotFoundPage />;
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
