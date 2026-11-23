import { useEffect, useRef, useState } from "react";
import { Edit03, Trash01 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Popconfirm } from "#src/components/ui/popconfirm";
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
import { InlineRefText } from "./artifact-inline-editor";
import { hasInlineRefs } from "./artifact-inline-refs";
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
        "flex flex-col gap-2 rounded-lg border p-3",
        flagged ? "border-error bg-primary" : "border-dashed border-secondary bg-secondary",
      )}
    >
      <div className="-my-1 flex min-h-8 min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-1.5 text-xs text-tertiary">
          <span className="shrink-0 tabular-nums">
            {m.av_cm_version({ version: draft.version })}
          </span>
          {draft.replyTo !== null ? (
            <span className="min-w-0 font-medium text-secondary [overflow-wrap:anywhere]">
              {parent ? m.av_dr_replying_to({ name: parent.name }) : m.av_dr_replying_earlier()}
            </span>
          ) : draft.path === null ? (
            <span className="min-w-0 font-medium text-secondary">{m.av_cm_group_whole()}</span>
          ) : (
            <CommentAnchorLine
              commentId={draft.id}
              version={draft.version}
              path={draft.path}
              anchor={draft.anchor}
            />
          )}
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center">
            <ButtonUtility
              icon={Edit03}
              size="xs"
              color="tertiary"
              tooltip={m.av_cm_edit()}
              isDisabled={quiet}
              data-draft-edit=""
              onClick={() => setEditing(true)}
            />
            <Popconfirm
              isDisabled={!hasImages(draft)}
              title={m.av_dr_delete_title()}
              description={m.av_dr_delete_body()}
              confirmLabel={m.av_dr_delete_confirm()}
              errorMessage={m.av_dr_delete_failed()}
              placement="bottom end"
              onConfirm={async () => {
                await actions.remove(draft);
              }}
            >
              <ButtonUtility
                icon={Trash01}
                size="xs"
                color="tertiary"
                tooltip={m.av_cm_delete()}
                isDisabled={quiet}
                data-draft-delete=""
                onClick={() => {
                  if (!hasImages(draft)) void actions.remove(draft);
                }}
              />
            </Popconfirm>
          </div>
        )}
      </div>
      {draft.replyTo !== null && parent?.excerpt && (
        <p className="line-clamp-2 text-xs text-tertiary [overflow-wrap:anywhere]">
          {m.av_cm_anchor_quote({ quote: parent.excerpt })}
        </p>
      )}
      {editing ? (
        <CommentEditor
          artifactId={artifactId}
          initial={draft.body}
          hasImages={hasImages(draft)}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            await actions.edit(draft, body);
            setEditing(false);
          }}
        />
      ) : (
        draft.body && (
          <div className={cn(COMMENT_BODY_CLASS, "message-text min-w-0")}>
            {hasInlineRefs(draft.body) ? (
              <InlineRefText body={draft.body} />
            ) : (
              <MessageBody body={draft.body} plainMentions={plainMentions} />
            )}
          </div>
        )
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
    </li>
  );
}
