import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { Button as AriaButton } from "react-aria-components";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { postAttachmentComment } from "./attachment-comments.functions";
import { useCommentAudience } from "./attachment-comment-audience";
import { CommentRow, useCommentDraft, useCommentPages } from "./attachment-comment-thread";
import { dragCarriesFiles } from "./composer-behavior";
import { ComposerField } from "./composer-field";
import { useConversationHostChannels } from "./conversation-host";
import { attachmentCommentsQueryKey } from "./conversation-query-keys";
import { useMentionCandidates } from "./mention-candidates";
import { COMMENT_FIELD_CLASS } from "./review-chrome";
import { ReviewPanelHeader } from "./review-panel-header";
import { useReferenceCompletion } from "./use-reference-completion";
import { anchorRangeLabel, type AttachmentCommentAnchor } from "./attachment-comment-anchors";
import { ANCHOR_HIGHLIGHT_MS, type AnchorSurface } from "./attachment-anchoring";
import type { AttachmentCommentView } from "#src/server/attachments/attachment-comments.server";

function anchorLabel(anchor: AttachmentCommentAnchor): string {
  const range = anchorRangeLabel(anchor);
  if (anchor.type === "md-section") return m.attachment_comments_anchor_section({ title: range });
  if (anchor.type === "html-region") return range || m.attachment_comments_anchor_region();
  if (anchor.type === "video-timestamp") return range;
  const single = anchor.data.start === anchor.data.end;
  if (anchor.type === "lines")
    return single
      ? m.attachment_comments_anchor_line({ range })
      : m.attachment_comments_anchor_lines({ range });
  return single
    ? m.attachment_comments_anchor_row({ range })
    : m.attachment_comments_anchor_rows({ range });
}

function refuseFileDrop(event: DragEvent) {
  if (!dragCarriesFiles(event.dataTransfer.types)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "none";
}

type Placed = { comment: AttachmentCommentView; order: number | null };

function AnchorChip({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <span className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md bg-secondary px-1.5 text-xs font-medium text-secondary">
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </span>
  );
}

function AnchorPlace({
  anchor,
  found,
  known,
  onJump,
}: {
  anchor: AttachmentCommentAnchor;
  found: boolean;
  known: boolean;
  onJump?: (anchor: AttachmentCommentAnchor) => void;
}) {
  const place = anchorLabel(anchor);
  const quote = "quote" in anchor.data ? anchor.data.quote : undefined;
  return (
    <div className="min-w-0 space-y-1">
      {found ? (
        <AriaButton
          className="block max-w-full cursor-pointer rounded-md outline-focus-ring transition-colors duration-150 hover:[&>span]:bg-tertiary focus-visible:outline-2"
          aria-label={m.attachment_comments_anchor_jump({ place })}
          onPress={() => onJump?.(anchor)}
        >
          <AnchorChip label={place} />
        </AriaButton>
      ) : (
        <p className="truncate text-xs text-tertiary">
          {known ? `${place} · ${m.attachment_comments_anchor_lost()}` : place}
        </p>
      )}
      {quote && (
        <blockquote className="border-l border-primary pl-3 text-sm whitespace-pre-wrap text-tertiary">
          {quote}
        </blockquote>
      )}
    </div>
  );
}

export function AttachmentCommentsPane({
  attachmentId,
  fileName,
  pendingAnchor,
  focusRequest,
  focusCommentId,
  onClearAnchor,
  surface,
  onJump,
}: {
  attachmentId: string;
  fileName: string;
  pendingAnchor?: AttachmentCommentAnchor | null;
  focusRequest?: number;
  focusCommentId?: string;
  onClearAnchor?: (anchor: AttachmentCommentAnchor) => void;
  surface?: AnchorSurface | null;
  onJump?: (anchor: AttachmentCommentAnchor) => void;
}) {
  const post = useServerFn(postAttachmentComment);
  const queryClient = useQueryClient();
  const queryKey = attachmentCommentsQueryKey(attachmentId);
  const { query, comments: all } = useCommentPages(attachmentId);
  const state = query.data?.pages[0];
  const { comments, located, rest } = useMemo(() => {
    const found: Placed[] = [];
    const others: Placed[] = [];
    for (const comment of all) {
      const order = comment.anchor && surface ? surface.locate(comment.anchor) : null;
      (order === null ? others : found).push({ comment, order });
    }
    found.sort((a, b) => a.order! - b.order! || a.comment.sequence - b.comment.sequence);
    return { comments: all, located: found, rest: others };
  }, [all, surface]);
  const canComment = Boolean(state?.canComment && !query.isError);
  const draft = useCommentDraft(
    attachmentId,
    canComment,
    async (body, idempotencyKey, mentions) => {
      const anchor = pendingAnchor;
      await post({
        data: { attachmentId, body, anchor: anchor ?? undefined, idempotencyKey, mentions },
      });
      if (anchor) onClearAnchor?.(anchor);
    },
    () => queryClient.invalidateQueries({ queryKey, exact: true }),
    () => completion.textareaRef.current?.focus(),
  );
  const { audience, mentionables, plainMentions, notifies } = useCommentAudience(
    attachmentId,
    all.at(-1)?.id,
  );
  const completion = useReferenceCompletion({
    mentionables: useMentionCandidates(mentionables, audience?.viewerId, canComment),
    channels: useConversationHostChannels(),
    value: draft.body,
    onChange: draft.setBody,
    onPickMention: draft.pinMention,
  });
  useEffect(() => {
    if (pendingAnchor || focusRequest) completion.textareaRef.current?.focus();
  }, [pendingAnchor, focusRequest, completion.textareaRef]);
  const [jumped, setJumped] = useState<string | null>(null);
  const clearJumped = useRef(0);
  useEffect(() => () => clearTimeout(clearJumped.current), []);
  const jumpTo = (id: string) => {
    setJumped(id);
    clearTimeout(clearJumped.current);
    clearJumped.current = window.setTimeout(() => setJumped(null), ANCHOR_HIGHLIGHT_MS);
  };
  const list = useRef<HTMLDivElement>(null);
  const reached = useRef<string>(undefined);
  const reach = useEffectEvent((id: string) => {
    if (all.some((comment) => comment.id === id)) {
      reached.current = id;
      jumpTo(id);
      list.current?.querySelector(`[data-comment-id="${id}"]`)?.scrollIntoView({ block: "center" });
    } else if (query.hasNextPage && !query.isFetching) void query.fetchNextPage();
  });
  useEffect(() => {
    if (focusCommentId && reached.current !== focusCommentId) reach(focusCommentId);
  }, [focusCommentId, all, query.hasNextPage, query.isFetching]);
  const disabledReason = query.isError ? undefined : state?.disabledReason;
  const notifyHint = useMemo(() => {
    if (!notifies) return undefined;
    const names = notifies(draft.wire.body, draft.wire.mentions);
    return names.length
      ? m.attachment_comments_will_notify({
          names: new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(names),
        })
      : undefined;
  }, [notifies, draft.wire]);
  const disabledText =
    disabledReason === "archived"
      ? m.attachment_comments_archived()
      : disabledReason === "not-member"
        ? m.attachment_comments_not_member()
        : disabledReason === "read-only"
          ? m.attachment_comments_read_only()
          : null;
  const renderComment = ({ comment, order }: Placed) => (
    <li key={comment.id}>
      <CommentRow
        highlighted={comment.id === jumped}
        comment={comment}
        plainMentions={plainMentions}
        viewerId={audience?.viewerId}
        place={
          comment.anchor && (
            <AnchorPlace
              anchor={comment.anchor}
              found={order !== null}
              known={Boolean(surface)}
              onJump={(anchor) => {
                jumpTo(comment.id);
                onJump?.(anchor);
              }}
            />
          )
        }
      />
    </li>
  );
  return (
    <section
      aria-label={m.attachment_comments_title()}
      className="flex h-full min-h-0 min-w-0 flex-col bg-primary"
    >
      <ReviewPanelHeader title={m.attachment_comments_title()} />
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {query.isPending ? (
          <div aria-busy="true" className="space-y-2">
            <span className="sr-only">{m.attachment_comments_loading()}</span>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-error-primary">
              {m.attachment_comments_load_failed()}
            </p>
            <Button size="sm" color="secondary" onClick={() => void query.refetch()}>
              {m.attachment_comments_retry()}
            </Button>
          </div>
        ) : comments.length === 0 ? (
          <p className="text-sm text-tertiary">{m.attachment_comments_empty()}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {query.hasNextPage && (
              <Button
                size="xs"
                color="tertiary"
                className="self-center"
                isLoading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {m.attachment_comments_older()}
              </Button>
            )}
            <ul className="flex flex-col gap-2">
              {rest.map(renderComment)}
              {located.map(renderComment)}
            </ul>
          </div>
        )}
      </div>
      <form
        className="shrink-0 space-y-2 border-t border-secondary p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void draft.submit();
        }}
        onDragOver={refuseFileDrop}
        onDrop={refuseFileDrop}
      >
        {disabledText && <p className="text-xs text-tertiary">{disabledText}</p>}
        {pendingAnchor && (
          <div className="flex min-w-0">
            <AnchorChip label={anchorLabel(pendingAnchor)}>
              <AriaButton
                aria-label={m.attachment_comments_anchor_remove()}
                className="-mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-quaternary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2"
                onPress={() => onClearAnchor?.(pendingAnchor)}
              >
                <XClose aria-hidden="true" className="size-3.5" />
              </AriaButton>
            </AnchorChip>
          </div>
        )}
        <div className={COMMENT_FIELD_CLASS}>
          <ComposerField
            completion={completion}
            value={draft.body}
            onValueChange={draft.setBody}
            label={m.attachment_comments_input({ name: fileName })}
            placeholder={m.attachment_comments_placeholder()}
            onSubmit={() => void draft.submit()}
            sendDisabled={!canComment || !draft.body.trim() || draft.sending}
            isDisabled={!canComment}
            isReadOnly={draft.sending}
            maxLength={8_000}
          />
        </div>
        {draft.sendFailed ? (
          <p role="alert" className="text-xs text-error-primary">
            {m.attachment_comments_post_failed()}
          </p>
        ) : (
          canComment && notifyHint && <p className="text-xs text-tertiary">{notifyHint}</p>
        )}
      </form>
    </section>
  );
}
