import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Empty, EmptyTitle, EmptyDescription } from "#src/components/ui/empty";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeZone } from "#src/lib/time-zone-context";
import { useTimeFormat } from "#src/lib/time-format-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { loadAttachmentComments, postAttachmentComment } from "./attachment-comments.functions";
import { anchorRangeLabel, type AttachmentCommentAnchor } from "./attachment-comment-anchors";
import type { AnchorSurface } from "./attachment-anchoring";
import type { AttachmentCommentView } from "#src/server/attachments/attachment-comments.server";
import { MessageBody } from "./message-body";

/** How a comment's place reads: `§ heading`, or its lines or rows. */
function anchorLabel(anchor: AttachmentCommentAnchor): string {
  const range = anchorRangeLabel(anchor);
  if (anchor.type === "md-section") return m.attachment_comments_anchor_section({ title: range });
  const single = anchor.data.start === anchor.data.end;
  if (anchor.type === "lines")
    return single
      ? m.attachment_comments_anchor_line({ range })
      : m.attachment_comments_anchor_lines({ range });
  return single
    ? m.attachment_comments_anchor_row({ range })
    : m.attachment_comments_anchor_rows({ range });
}

type Placed = { comment: AttachmentCommentView; order: number | null };

/** Where a comment points: a jump to it, or a note that the place is gone from the file. */
function AnchorPlace({
  anchor,
  found,
  known,
  onJump,
}: {
  anchor: AttachmentCommentAnchor;
  found: boolean;
  /** Whether the preview has been read, so a place not found is lost rather than unknown yet. */
  known: boolean;
  onJump?: (anchor: AttachmentCommentAnchor) => void;
}) {
  const place = anchorLabel(anchor);
  if (!found)
    return (
      <p className="mt-1 truncate text-xs text-tertiary">
        {known ? `${place} · ${m.attachment_comments_anchor_lost()}` : place}
      </p>
    );
  return (
    <Button
      size="xs"
      color="link-color"
      className="mt-1 block max-w-full truncate"
      aria-label={m.attachment_comments_anchor_jump({ place })}
      onClick={() => onJump?.(anchor)}
    >
      {place}
    </Button>
  );
}

/**
 * Only mounted while its file is open. A draft survives switching preview/comments on a phone.
 * With the preview's `surface`, comments on a place that is still found come first, in document
 * order; whole-file comments and those whose place is gone follow, as in Raft.
 */
export function AttachmentCommentsPane({
  attachmentId,
  fileName,
  pendingAnchor,
  onClearAnchor,
  surface,
  onJump,
}: {
  attachmentId: string;
  fileName: string;
  /** The place the next comment is about, chosen in the preview; absent for the whole file. */
  pendingAnchor?: AttachmentCommentAnchor | null;
  /** Drops `anchor` if it is still the pending one. */
  onClearAnchor?: (anchor: AttachmentCommentAnchor) => void;
  surface?: AnchorSurface | null;
  onJump?: (anchor: AttachmentCommentAnchor) => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const post = useServerFn(postAttachmentComment);
  const input = useRef<HTMLTextAreaElement>(null);
  // A place chosen in the preview is what the reader is about to write about.
  useEffect(() => {
    if (pendingAnchor) input.current?.focus();
  }, [pendingAnchor]);
  const queryClient = useQueryClient();
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const queryKey = ["attachment-comments", attachmentId];
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      loadAttachmentComments({ data: { attachmentId, beforeSequence: pageParam } }),
    getNextPageParam: (page) => (page.hasOlder ? page.comments[0]?.sequence : undefined),
    refetchInterval: 5_000,
  });
  const state = query.data?.pages[0];
  // Placed once per load of comments or new preview, not on every keystroke in the draft.
  const { comments, located, rest } = useMemo(() => {
    const all = query.data ? [...query.data.pages].reverse().flatMap((page) => page.comments) : [];
    const found: Placed[] = [];
    const others: Placed[] = [];
    for (const comment of all) {
      const order = comment.anchor && surface ? surface.locate(comment.anchor) : null;
      (order === null ? others : found).push({ comment, order });
    }
    found.sort((a, b) => a.order! - b.order! || a.comment.sequence - b.comment.sequence);
    return { comments: all, located: found, rest: others };
  }, [query.data, surface]);
  const canComment = Boolean(state?.canComment && !query.isError);
  const disabledReason = state?.disabledReason;
  const emptyHint = m.attachment_comments_empty_hint({ name: "{name}" }).split("{name}");
  const disabledText =
    disabledReason === "archived"
      ? m.attachment_comments_archived()
      : disabledReason === "not-member"
        ? m.attachment_comments_not_member()
        : disabledReason === "read-only"
          ? m.attachment_comments_read_only()
          : null;
  const renderComment = ({ comment, order }: Placed) => (
    <article key={comment.id} className="flex min-w-0 gap-2.5">
      <IdentityAvatar src={comment.senderAvatarUrl} name={comment.senderName} size="xs" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-primary">{comment.senderName}</p>
        <time dateTime={comment.createdAt} className="text-xs text-tertiary">
          {formatDateForDisplay(comment.createdAt, timeZone, getLocale(), timeFormat)}
        </time>
        {comment.anchor && (
          <AnchorPlace
            anchor={comment.anchor}
            found={order !== null}
            known={Boolean(surface)}
            onJump={onJump}
          />
        )}
        <div className="mt-1 text-sm text-secondary">
          <MessageBody body={comment.body} />
        </div>
      </div>
    </article>
  );
  async function submit() {
    if (!body.trim() || sending || !canComment) return;
    setSending(true);
    setSendFailed(false);
    // A place chosen while this posts is the next comment's.
    const anchor = pendingAnchor;
    try {
      await post({ data: { attachmentId, body, anchor: anchor ?? undefined } });
      setBody("");
      if (anchor) onClearAnchor?.(anchor);
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      setSendFailed(true);
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setSending(false);
      // The post button disables itself once the draft is cleared, which drops focus to the page
      // (and the dialog stops hearing Escape); give it back to the field.
      input.current?.focus();
    }
  }
  return (
    <section
      aria-label={m.attachment_comments_title()}
      className="flex h-full min-h-0 min-w-0 flex-col bg-primary"
    >
      <h2 className="shrink-0 border-b border-secondary px-4 py-3 text-sm font-semibold text-primary">
        <Tooltip title={m.attachment_comments_open({ name: fileName })}>
          <TooltipTrigger aria-label={m.attachment_comments_open({ name: fileName })}>
            {m.attachment_comments_title()}
          </TooltipTrigger>
        </Tooltip>
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {query.isPending ? (
          <p className="text-sm text-tertiary">{m.attachment_comments_loading()}</p>
        ) : query.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-error-primary">
              {m.attachment_comments_load_failed()}
            </p>
            <Button size="sm" color="secondary" onClick={() => void query.refetch()}>
              {m.attachment_comments_retry()}
            </Button>
          </div>
        ) : comments.length === 0 ? (
          <Empty className="h-full p-4">
            <EmptyTitle className="text-sm text-tertiary">
              {m.attachment_comments_empty()}
            </EmptyTitle>
            <EmptyDescription>
              {emptyHint[0]}
              <strong>{fileName}</strong>
              {emptyHint[1]}
            </EmptyDescription>
          </Empty>
        ) : (
          <div className="space-y-5">
            {query.hasNextPage && (
              <Button
                size="sm"
                color="tertiary"
                isLoading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {m.attachment_comments_older()}
              </Button>
            )}
            {located.map(renderComment)}
            {located.length > 0 && rest.length > 0 && (
              <h3 className="border-t border-secondary pt-4 text-xs font-medium text-tertiary">
                {m.attachment_comments_whole_file()}
              </h3>
            )}
            {rest.map(renderComment)}
          </div>
        )}
      </div>
      <form
        className="shrink-0 space-y-2 border-t border-secondary p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {disabledText && <p className="text-sm text-tertiary">{disabledText}</p>}
        {pendingAnchor && (
          <div className="flex min-w-0 items-center gap-1 text-sm font-medium text-brand-secondary">
            <span className="min-w-0 flex-1 truncate">{anchorLabel(pendingAnchor)}</span>
            <ButtonUtility
              icon={XClose}
              size="xs"
              color="tertiary"
              tooltip={m.attachment_comments_anchor_remove()}
              onClick={() => onClearAnchor?.(pendingAnchor)}
            />
          </div>
        )}
        <TextArea
          aria-label={m.attachment_comments_input({ name: fileName })}
          placeholder={m.attachment_comments_input({ name: fileName })}
          value={body}
          onChange={setBody}
          textAreaRef={input}
          maxLength={8_000}
          rows={3}
          isDisabled={!canComment}
          // Read-only, not disabled, while sending: a disabled field drops focus to the page, and
          // the dialog would no longer hear Escape.
          isReadOnly={sending}
        />
        {sendFailed && (
          <p role="alert" className="text-sm text-error-primary">
            {m.attachment_comments_post_failed()}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            isDisabled={!canComment || !body.trim()}
            isLoading={sending}
          >
            {m.attachment_comments_post()}
          </Button>
        </div>
      </form>
    </section>
  );
}
