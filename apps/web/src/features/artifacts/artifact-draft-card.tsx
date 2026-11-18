import { useEffect, useRef, useState } from "react";
import { Edit03, Trash01 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { MessageBody } from "#src/features/conversations/message-body";
import { COMMENT_BODY_CLASS } from "#src/features/conversations/review-chrome";
import type { ChipMention } from "#src/features/conversations/message-reference-chips";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { formatList } from "#src/lib/format-list";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { CommentAnchorLine } from "./artifact-comment-anchor";
import { COMMENT_MENTIONS_MAX } from "./artifact-comment-inputs";
import { CommentEditor } from "./artifact-comment-thread";
import {
  useCommentDraftActions,
  useCommentDrafts,
  type DraftRefusal,
} from "./artifact-comment-drafts-context";
import {
  commentDraftImageUrl,
  expiryWarningDays,
  hasImages,
  type CommentDraftView,
} from "./artifact-comment-drafts-queries";

export type DraftParent = { name: string; excerpt: string } | null;

export function refusalText({ reason, names }: Pick<DraftRefusal, "reason" | "names">) {
  switch (reason) {
    case "mention-cannot-see":
      return m.av_dr_why_mention({ names: formatList(names.map((name) => `@${name}`)) });
    case "too-many-mentions":
      return m.av_dr_why_too_many({ count: COMMENT_MENTIONS_MAX });
    case "file-gone":
      return m.av_dr_why_file();
    case "version-gone":
      return m.av_dr_why_version();
    case "reply-gone":
      return m.av_dr_why_reply();
    case "invalid":
      return m.av_dr_why_invalid();
  }
}

export function DraftCard({
  draft,
  artifactId,
  parent,
  refusal,
  plainMentions,
}: {
  draft: CommentDraftView;
  artifactId: string;
  parent: DraftParent;
  refusal: DraftRefusal | null;
  plainMentions: Map<string, ChipMention> | undefined;
}) {
  const drafts = useCommentDrafts();
  const actions = useCommentDraftActions();
  const workspaceSlug = useWorkspaceSlug();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const card = useRef<HTMLLIElement>(null);
  const { focus } = drafts;
  const { consumeFocus } = actions;
  useEffect(() => {
    if (focus !== draft.id) return;
    consumeFocus();
    card.current?.scrollIntoView({ block: "nearest" });
    setEditing(true);
  }, [focus, draft.id, consumeFocus]);
  const flagged = refusal !== null;
  useEffect(() => {
    if (flagged) card.current?.scrollIntoView({ block: "nearest" });
  }, [flagged]);
  const daysLeft = expiryWarningDays(draft.expiresAt);
  const quiet = drafts.busy;
  return (
    <li
      ref={card}
      data-draft-id={draft.id}
      aria-invalid={flagged || undefined}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-primary p-3",
        flagged ? "border-error" : "border-dashed border-primary",
      )}
    >
      <div className="-my-1 flex min-h-8 min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-tertiary tabular-nums">
          {m.av_cm_version({ version: draft.version })}
        </span>
        {!editing && (
          <>
            <ButtonUtility
              icon={Edit03}
              size="xs"
              color="tertiary"
              tooltip={m.av_cm_edit()}
              isDisabled={quiet}
              data-draft-edit=""
              onClick={() => setEditing(true)}
            />
            <ButtonUtility
              icon={Trash01}
              size="xs"
              color="tertiary"
              tooltip={m.av_cm_delete()}
              isDisabled={quiet}
              data-draft-delete=""
              onClick={() => (hasImages(draft) ? setConfirming(true) : void actions.remove(draft))}
            />
          </>
        )}
      </div>
      {draft.replyTo !== null ? (
        <p className="text-xs text-tertiary [overflow-wrap:anywhere]">
          <span className="font-medium text-secondary">
            {parent ? m.av_dr_replying_to({ name: parent.name }) : m.av_dr_replying_earlier()}
          </span>
          {parent?.excerpt && (
            <span className="line-clamp-2 block">
              {m.av_cm_anchor_quote({ quote: parent.excerpt })}
            </span>
          )}
        </p>
      ) : draft.path === null ? (
        <p className="text-xs font-medium text-secondary">{m.av_cm_group_whole()}</p>
      ) : (
        <CommentAnchorLine
          commentId={draft.id}
          version={draft.version}
          path={draft.path}
          anchor={draft.anchor}
        />
      )}
      {editing ? (
        <CommentEditor
          initial={draft.body}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            await actions.edit(draft, body);
            setEditing(false);
          }}
        />
      ) : (
        <>
          {draft.body && (
            <div className={cn(COMMENT_BODY_CLASS, "message-text min-w-0")}>
              <MessageBody body={draft.body} plainMentions={plainMentions} />
            </div>
          )}
          {hasImages(draft) && (
            <ul className="flex flex-wrap gap-2">
              {draft.images.map((image) => (
                <li key={image.position}>
                  <img
                    src={commentDraftImageUrl(workspaceSlug, artifactId, draft.id, image.position)}
                    alt={m.av_cm_image_alt()}
                    width={image.width}
                    height={image.height}
                    loading="lazy"
                    className="max-h-40 w-auto max-w-full rounded-md border border-secondary object-contain"
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {refusal && (
        <p role="alert" className="text-xs text-error-primary">
          {refusalText(refusal)}
        </p>
      )}
      {daysLeft !== null && (
        <p className={cn("text-xs", daysLeft === 0 ? "text-warning-primary" : "text-tertiary")}>
          {daysLeft === 0 ? m.av_dr_expires_today() : m.av_dr_expires({ count: daysLeft })}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={m.av_dr_delete_title()}
        description={m.av_dr_delete_body()}
        confirmLabel={m.av_dr_delete_confirm()}
        errorMessage={m.av_dr_delete_failed()}
        onConfirm={async () => {
          await actions.remove(draft);
          setConfirming(false);
        }}
      />
    </li>
  );
}
