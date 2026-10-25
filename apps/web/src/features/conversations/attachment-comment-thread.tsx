import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { TextArea } from "#src/components/base/textarea/textarea";
import { useAppToast } from "#src/components/ui/toast";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type { AttachmentCommentView } from "#src/server/attachments/attachment-comments.server";
import {
  loadAttachmentComments,
  postAttachmentComment,
  reactAttachmentComment,
} from "./attachment-comments.functions";
import { MessageBody } from "./message-body";
import { MessageReactionBadges } from "./message-reaction-badges";
import { MessageReactionPicker } from "./message-reaction-picker";

type ReactTo = (messageId: string, emoji: string, active: boolean) => void;

/** One attachment's root comments, or with `rootId` one root comment's replies. */
export const attachmentCommentsKey = (attachmentId: string, rootId?: string): QueryKey =>
  rootId
    ? ["attachment-comments", attachmentId, "replies", rootId]
    : ["attachment-comments", attachmentId];

/**
 * One list of comments (`attachmentCommentsKey`), paged backwards from the newest and read again
 * every few seconds while `enabled`; `comments` runs oldest first across the loaded pages.
 */
export function useCommentPages(attachmentId: string, rootId?: string, enabled = true) {
  const query = useInfiniteQuery({
    queryKey: attachmentCommentsKey(attachmentId, rootId),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      loadAttachmentComments({ data: { attachmentId, rootId, beforeSequence: pageParam } }),
    getNextPageParam: (page) => (page.hasOlder ? page.comments[0]?.sequence : undefined),
    enabled,
    refetchInterval: 5_000,
  });
  const comments = useMemo(
    () => (query.data ? [...query.data.pages].reverse().flatMap((page) => page.comments) : []),
    [query.data],
  );
  return { query, comments };
}

/**
 * A comment or reply field's draft and sending state. `send` posts the draft; `refresh` reads the
 * lists it changes again, whether or not it was posted. The field keeps focus throughout.
 */
export function useCommentDraft(
  canComment: boolean,
  send: (body: string) => Promise<unknown>,
  refresh: () => Promise<unknown>,
) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  async function submit() {
    if (!body.trim() || sending || !canComment) return;
    setSending(true);
    setSendFailed(false);
    try {
      await send(body);
      setBody("");
    } catch {
      setSendFailed(true);
    } finally {
      await refresh();
      setSending(false);
      // The post button disables itself once the draft is cleared, which drops focus to the page
      // (and the dialog stops hearing Escape); give it back to the field.
      input.current?.focus();
    }
  }
  return { body, setBody, sending, sendFailed, input, submit };
}

/**
 * Reacting to the comments of one list (`attachmentCommentsKey`), the way a message is reacted to:
 * any quick emoji, ✅ among them, which is all "resolved" means. That list reads again afterwards.
 */
export function useCommentReaction(attachmentId: string, rootId?: string): ReactTo {
  const react = useServerFn(reactAttachmentComment);
  const queryClient = useQueryClient();
  const toast = useAppToast();
  return useCallback(
    async (messageId, emoji, active) => {
      try {
        await react({ data: { attachmentId, messageId, emoji, active } });
      } catch {
        toast.error(m.conversation_reaction_error());
      }
      await queryClient.invalidateQueries({
        queryKey: attachmentCommentsKey(attachmentId, rootId),
        exact: true,
      });
    },
    [react, attachmentId, rootId, queryClient, toast],
  );
}

/**
 * One comment or reply: who wrote it and when, its place (`place`, for a root comment), its body,
 * its reactions and what can be done with it (`actions`). Without `onReact` (no right to comment)
 * its reactions only show.
 */
function CommentEntry({
  comment,
  viewerId,
  place,
  onReact,
  actions,
}: {
  comment: AttachmentCommentView;
  viewerId: string;
  place?: ReactNode;
  onReact?: ReactTo;
  actions?: ReactNode;
}) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  return (
    <article className="flex min-w-0 gap-2.5">
      <IdentityAvatar src={comment.senderAvatarUrl} name={comment.senderName} size="xs" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-primary">{comment.senderName}</p>
        <time dateTime={comment.createdAt} className="text-xs text-tertiary">
          {formatDateForDisplay(comment.createdAt, timeZone, getLocale(), timeFormat)}
        </time>
        {place}
        <div className="mt-1 text-sm text-secondary">
          <MessageBody body={comment.body} />
        </div>
        <MessageReactionBadges
          reactions={comment.reactions}
          viewerId={viewerId}
          onToggle={onReact && ((emoji, active) => onReact(comment.id, emoji, active))}
        />
        {(onReact || actions) && (
          <div className="mt-1 flex items-center gap-1">
            {onReact && (
              <MessageReactionPicker onPick={(emoji) => onReact(comment.id, emoji, true)} />
            )}
            {actions}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * A root comment with its replies behind a reply entry: "Reply" while there are none, the count
 * once there are, as in Raft. Opening it lists the replies, oldest first, with a field to add one.
 * `onReact` reacts to the root comment, in the list it belongs to.
 */
export function CommentThread({
  attachmentId,
  root,
  viewerId,
  place,
  canComment,
  onReact,
}: {
  attachmentId: string;
  root: AttachmentCommentView;
  viewerId: string;
  place?: ReactNode;
  canComment: boolean;
  onReact?: ReactTo;
}) {
  const [open, setOpen] = useState(false);
  const { query, comments: replies } = useCommentPages(
    attachmentId,
    root.id,
    open && root.replyCount > 0,
  );
  const repliesKey = attachmentCommentsKey(attachmentId, root.id);
  const reactToReply = useCommentReaction(attachmentId, root.id);
  const post = useServerFn(postAttachmentComment);
  const queryClient = useQueryClient();
  const draft = useCommentDraft(
    canComment,
    (body) => post({ data: { attachmentId, body, rootId: root.id } }),
    // The root list carries the reply count.
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: repliesKey, exact: true }),
        queryClient.invalidateQueries({
          queryKey: attachmentCommentsKey(attachmentId),
          exact: true,
        }),
      ]),
  );
  const replyEntry = (canComment || root.replyCount > 0) && (
    <Button size="xs" color="link-gray" aria-expanded={open} onClick={() => setOpen(!open)}>
      {root.replyCount > 0
        ? m.attachment_comments_reply_count({ count: root.replyCount })
        : m.attachment_comments_reply()}
    </Button>
  );
  return (
    <div className="space-y-3">
      <CommentEntry
        comment={root}
        viewerId={viewerId}
        place={place}
        onReact={onReact}
        actions={replyEntry}
      />
      {open && (
        <div className="ml-3.5 space-y-3 border-l border-secondary pl-4">
          {query.isError && (
            <div className="flex items-center gap-2">
              <p role="alert" className="text-sm text-error-primary">
                {m.attachment_comments_load_failed()}
              </p>
              <Button size="xs" color="secondary" onClick={() => void query.refetch()}>
                {m.attachment_comments_retry()}
              </Button>
            </div>
          )}
          {query.hasNextPage && (
            <Button
              size="xs"
              color="tertiary"
              isLoading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {m.attachment_comments_older_replies()}
            </Button>
          )}
          {replies.map((reply) => (
            <CommentEntry
              key={reply.id}
              comment={reply}
              viewerId={viewerId}
              onReact={canComment ? reactToReply : undefined}
            />
          ))}
          {canComment && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void draft.submit();
              }}
            >
              <TextArea
                aria-label={m.attachment_comments_reply()}
                placeholder={m.attachment_comments_reply()}
                value={draft.body}
                onChange={draft.setBody}
                textAreaRef={draft.input}
                maxLength={8_000}
                rows={2}
                // Opening the replies is to write one.
                autoFocus
                // Read-only, not disabled, while sending, as in the comment field.
                isReadOnly={draft.sending}
              />
              {draft.sendFailed && (
                <p role="alert" className="text-sm text-error-primary">
                  {m.attachment_comments_reply_failed()}
                </p>
              )}
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="xs"
                  isDisabled={!draft.body.trim()}
                  isLoading={draft.sending}
                >
                  {m.attachment_comments_post_reply()}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
