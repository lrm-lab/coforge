import { XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import type { ChipMention } from "#src/features/conversations/message-reference-chips";
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
  const { pending } = drafts;
  const count = drafts.drafts.length;
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-secondary py-2 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold text-primary">
          {m.av_dr_pending_title({ count })}
        </h2>
        <ButtonUtility
          icon={XClose}
          size="xs"
          color="tertiary"
          tooltip={m.av_cm_close()}
          onClick={onClose}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
        {pending.banner && (
          <p
            role="status"
            data-pending-banner={pending.banner}
            className="mb-3 rounded-lg bg-warning-secondary px-3 py-2 text-sm text-warning-primary"
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
      <footer className="flex shrink-0 justify-end gap-2 border-t border-secondary px-3 py-2">
        <Button size="sm" color="secondary" onPress={closePending}>
          {m.av_dr_back()}
        </Button>
        <Button
          size="sm"
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
