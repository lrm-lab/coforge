import { useMemo } from "react";

import type { ChipMention } from "#src/features/conversations/message-reference-chips";
import { clip } from "./artifact-text-anchor";
import { useCommentDrafts, type DraftRefusal } from "./artifact-comment-drafts-context";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";
import type { ArtifactCommentView } from "./artifact-comment-queries";
import { DraftCard, type DraftParent } from "./artifact-draft-card";

const EXCERPT_MAX = 160;

export const draftsInPanelOrder = (drafts: readonly CommentDraftView[]) => [
  ...drafts.filter((draft) => draft.replyTo === null),
  ...drafts.filter((draft) => draft.replyTo !== null),
];

function parentOf(comments: readonly ArtifactCommentView[], replyTo: string | null): DraftParent {
  const found = replyTo === null ? undefined : comments.find((comment) => comment.id === replyTo);
  if (!found || "deleted" in found) return null;
  return { name: found.author.name, excerpt: clip(found.body, EXCERPT_MAX) };
}

export function DraftList({
  artifactId,
  comments,
  plainMentions,
  refusal,
}: {
  artifactId: string;
  comments: readonly ArtifactCommentView[];
  plainMentions: Map<string, ChipMention> | undefined;
  refusal: DraftRefusal | null;
}) {
  const { drafts } = useCommentDrafts();
  const ordered = useMemo(() => draftsInPanelOrder(drafts), [drafts]);
  return (
    <ul className="flex flex-col gap-2">
      {ordered.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          artifactId={artifactId}
          parent={parentOf(comments, draft.replyTo)}
          refusal={refusal?.draftId === draft.id ? refusal : null}
          plainMentions={plainMentions}
        />
      ))}
    </ul>
  );
}
