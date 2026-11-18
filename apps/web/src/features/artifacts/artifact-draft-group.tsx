import { useMemo } from "react";

import type { ChipMention } from "#src/features/conversations/message-reference-chips";
import { SECTION_LABEL_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { clip } from "./artifact-text-anchor";
import { useCommentDrafts, type DraftRefusal } from "./artifact-comment-drafts-context";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";
import type { ArtifactCommentView } from "./artifact-comment-queries";
import { DraftCard, type DraftParent } from "./artifact-draft-card";
import { DraftsLoadFailed } from "./artifact-drafts-load-failed";

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

export function DraftGroup({
  artifactId,
  comments,
  plainMentions,
}: {
  artifactId: string;
  comments: readonly ArtifactCommentView[];
  plainMentions: Map<string, ChipMention> | undefined;
}) {
  const { drafts, loadFailed } = useCommentDrafts();
  if (loadFailed && drafts.length === 0) return <DraftsLoadFailed />;
  if (drafts.length === 0) return null;
  return (
    <section data-draft-group="">
      <h3 className={cn(SECTION_LABEL_CLASS, "mb-2 truncate")}>{m.av_dr_group()}</h3>
      <DraftList
        artifactId={artifactId}
        comments={comments}
        plainMentions={plainMentions}
        refusal={null}
      />
    </section>
  );
}
