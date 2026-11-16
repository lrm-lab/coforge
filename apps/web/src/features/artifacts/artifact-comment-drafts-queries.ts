import { queryOptions } from "@tanstack/react-query";

import { COMMENT_DRAFT_EXPIRY_WARNING_DAYS } from "./artifact-comment-draft-inputs";
import { loadCommentDrafts } from "./artifact-comment-drafts.functions";
import { ARTIFACTS_KEY } from "./artifact-queries";

export type CommentDraftsRead = Awaited<ReturnType<typeof loadCommentDrafts>>;

export type CommentDraftView = CommentDraftsRead["drafts"][number];

export const inCreationOrder = (drafts: readonly CommentDraftView[]) =>
  [...drafts].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );

export const commentDraftsKey = (artifactId: string) =>
  [...ARTIFACTS_KEY, "comment-drafts", artifactId] as const;

export const commentDraftsQuery = (artifactId: string) =>
  queryOptions({
    queryKey: commentDraftsKey(artifactId),
    queryFn: () => loadCommentDrafts({ data: { artifactId } }),
    staleTime: 30_000,
  });

export const commentDraftImageUrl = (
  workspaceSlug: string,
  artifactId: string,
  draftId: string,
  position: number,
) =>
  `/api/workspaces/${encodeURIComponent(workspaceSlug)}/artifacts/${artifactId}/comment-drafts/${draftId}/images/${position}`;

const DAY_MS = 24 * 60 * 60 * 1000;

export function expiryWarningDays(expiresAt: Date | string, now: number = Date.now()) {
  const days = Math.ceil((new Date(expiresAt).getTime() - now) / DAY_MS);
  return days <= COMMENT_DRAFT_EXPIRY_WARNING_DAYS ? Math.max(0, days) : null;
}

export const hasImages = (draft: Pick<CommentDraftView, "images">) => draft.images.length > 0;
