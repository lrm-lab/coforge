import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Empty, EmptyTitle, EmptyDescription } from "#src/components/ui/empty";
import { m } from "#src/paraglide/messages";
import { postAttachmentComment } from "./attachment-comments.functions";
import {
  attachmentCommentsKey,
  CommentThread,
  useCommentDraft,
  useCommentPages,
  useCommentReaction,
} from "./attachment-comment-thread";
import { anchorRangeLabel, type AttachmentCommentAnchor } from "./attachment-comment-anchors";
import type { AnchorSurface } from "./attachment-anchoring";
import type { AttachmentCommentView } from "#src/server/attachments/attachment-comments.server";

/** How a comment's place reads: `§ heading`, or its lines or rows. */
function anchorLabel(anchor: AttachmentCommentAnchor): string {
  const range = anchorRangeLabel(anchor);
  if (anchor.type === "md-section") return m.attachment_comments_anchor_section({ title: range });
  if (anchor.type === "html-region") return range || m.attachment_comments_anchor_region();
  const single = anchor.data.start === anchor.data.end;
  if (anchor.type === "lines")
    return single
      ? m.attachment_comments_anchor_line({ range })
      : m.attachment_comments_anchor_lines({ range });
  return single
    ? m.attachment_comments_anchor_row({ range })
    : m.attachment_comments_anchor_rows({ range });
}

const workspaceRoute = getRouteApi("/w/$workspaceSlug");

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
  focusRequest,
  onClearAnchor,
  surface,
  onJump,
}: {
  attachmentId: string;
  fileName: string;
  /** The place the next comment is about, chosen in the preview; absent for the whole file. */
  pendingAnchor?: AttachmentCommentAnchor | null;
  /** Changes each time the preview asks to start a comment, with or without a place. */
  focusRequest?: number;
  /** Drops `anchor` if it is still the pending one. */
  onClearAnchor?: (anchor: AttachmentCommentAnchor) => void;
  surface?: AnchorSurface | null;
  onJump?: (anchor: AttachmentCommentAnchor) => void;
}) {
  const viewerId = workspaceRoute.useLoaderData({ select: ({ user }) => user.id });
  const post = useServerFn(postAttachmentComment);
  const queryClient = useQueryClient();
  const queryKey = attachmentCommentsKey(attachmentId);
  const react = useCommentReaction(attachmentId);
  const { query, comments: all } = useCommentPages(attachmentId);
  const state = query.data?.pages[0];
  // Placed once per load of comments or new preview, not on every keystroke in the draft.
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
    canComment,
    async (body) => {
      // A place chosen while this posts is the next comment's.
      const anchor = pendingAnchor;
      await post({ data: { attachmentId, body, anchor: anchor ?? undefined } });
      if (anchor) onClearAnchor?.(anchor);
    },
    () => queryClient.invalidateQueries({ queryKey, exact: true }),
  );
  // A place chosen in the preview is what the reader is about to write about.
  useEffect(() => {
    if (pendingAnchor || focusRequest) draft.input.current?.focus();
  }, [pendingAnchor, focusRequest, draft.input]);
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
    <CommentThread
      key={comment.id}
      attachmentId={attachmentId}
      root={comment}
      viewerId={viewerId}
      canComment={canComment}
      onReact={canComment ? react : undefined}
      place={
        comment.anchor && (
          <AnchorPlace
            anchor={comment.anchor}
            found={order !== null}
            known={Boolean(surface)}
            onJump={onJump}
          />
        )
      }
    />
  );
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
          void draft.submit();
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
          value={draft.body}
          onChange={draft.setBody}
          textAreaRef={draft.input}
          maxLength={8_000}
          rows={3}
          isDisabled={!canComment}
          // Read-only, not disabled, while sending: a disabled field drops focus to the page, and
          // the dialog would no longer hear Escape.
          isReadOnly={draft.sending}
        />
        {draft.sendFailed && (
          <p role="alert" className="text-sm text-error-primary">
            {m.attachment_comments_post_failed()}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            isDisabled={!canComment || !draft.body.trim()}
            isLoading={draft.sending}
          >
            {m.attachment_comments_post()}
          </Button>
        </div>
      </form>
    </section>
  );
}
