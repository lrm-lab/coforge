import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { loadArtifactReview } from "./artifact-comment-drafts.functions";
import { ARTIFACTS_KEY } from "./artifact-queries";

export type ReviewFilter = ReturnType<typeof useReviewFilter>;

export function useReviewFilter(
  artifactId: string,
  reviewId: string | undefined,
  onClear: () => void,
) {
  const [showing, setShowing] = useState(reviewId !== undefined);
  const active = showing && reviewId !== undefined;
  const query = useQuery({
    queryKey: [...ARTIFACTS_KEY, "review", artifactId, reviewId],
    queryFn: () => loadArtifactReview({ data: { artifactId, reviewId: reviewId! } }),
    enabled: active,
    staleTime: 30_000,
  });
  const review = query.data?.review ?? null;
  return {
    offered: reviewId !== undefined && (review !== null || query.isPending),
    active,
    query,
    review,
    comments: query.data?.comments ?? [],
    missing: query.isSuccess && review === null,
    show: () => setShowing(true),
    showAll: () => {
      setShowing(false);
      onClear();
    },
  };
}
