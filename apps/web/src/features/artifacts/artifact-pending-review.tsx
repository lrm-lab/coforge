import { useEffect } from "react";
import { Button } from "#src/components/base/buttons/button";
import type { ChipMention } from "#src/features/conversations/message-reference-chips";
import { ReviewPanelHeader } from "#src/features/conversations/review-panel-header";
import { m } from "#src/paraglide/messages";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import type { ArtifactCommentView } from "./artifact-comment-queries";
import { DraftList } from "./artifact-draft-group";
import { DraftsLoadFailed } from "./artifact-drafts-load-failed";

export function ArtifactPendingReview({
  artifactId,
  comments,
  plainMentions,
  onClose,
}: {
  artifactId: string;
  comments: readonly ArtifactCommentView[];
  plainMentions: Map<string, ChipMention> | undefined;
  onClose: () => void;
}) {
  const drafts = useCommentDrafts();
  const { submit, closePending } = useCommentDraftActions();
  useEffect(() => closePending, [closePending]);
  const { pending } = drafts;
  const count = drafts.drafts.length;
  return (
    <>
      <ReviewPanelHeader
        title={m.av_dr_pending_title({ count })}
        close={{ label: m.av_cm_close(), onPress: onClose }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
        {pending.banner && (
          <p
            role="status"
            data-pending-banner={pending.banner}
            className="mb-3 rounded-lg bg-secondary p-3 text-sm text-secondary"
          >
            {pending.banner === "refused" ? m.av_dr_pending_refused() : m.av_dr_pending_changed()}
          </p>
        )}
        {drafts.loadFailed && <DraftsLoadFailed className="mb-3" />}
        <DraftList
          artifactId={artifactId}
          comments={comments}
          plainMentions={plainMentions}
          refusal={pending.refusal}
        />
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-secondary p-3">
        <Button size="xs" color="secondary" onPress={onClose}>
          {m.av_dr_back()}
        </Button>
        <Button
          size="xs"
          color="primary"
          isDisabled={count === 0 || drafts.busy}
          isLoading={drafts.submitting}
          data-send-drafts=""
          onPress={() => void submit()}
        >
          {m.av_dr_send_n({ count })}
        </Button>
      </footer>
    </>
  );
}
