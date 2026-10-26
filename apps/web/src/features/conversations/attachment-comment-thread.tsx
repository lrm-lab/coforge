import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { clockLabel } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { getLocale } from "#src/paraglide/runtime";
import type { AttachmentCommentView } from "#src/server/attachments/attachment-comments.server";
import { loadAttachmentComments } from "./attachment-comments.functions";
import { shouldSendOnEnter } from "./composer-behavior";
import { MessageBody } from "./message-body";

/** One attachment's root comments. */
export const attachmentCommentsKey = (attachmentId: string): QueryKey => [
  "attachment-comments",
  attachmentId,
];

/**
 * An attachment's comments (`attachmentCommentsKey`), paged backwards from the newest and read
 * again every few seconds; `comments` runs oldest first across the loaded pages.
 */
export function useCommentPages(attachmentId: string) {
  const query = useInfiniteQuery({
    queryKey: attachmentCommentsKey(attachmentId),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      loadAttachmentComments({ data: { attachmentId, beforeSequence: pageParam } }),
    getNextPageParam: (page) => (page.hasOlder ? page.comments[0]?.sequence : undefined),
    refetchInterval: 5_000,
  });
  const comments = useMemo(
    () => (query.data ? [...query.data.pages].reverse().flatMap((page) => page.comments) : []),
    [query.data],
  );
  return { query, comments };
}

/**
 * The comment field's draft and sending state. `send` posts the draft; `refresh` reads the
 * lists it changes again, whether or not it was posted. The field keeps focus throughout. Spread
 * `keys` on the field: Enter sends and Shift+Enter starts a new line, as in the composer and in
 * Raft, and an Enter that confirms an IME composition sends nothing.
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
  const composing = useRef(false);
  const compositionEndedAt = useRef<number | null>(null);
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
  const keys = {
    onTextAreaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const key = {
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing || composing.current,
        keyCode: event.keyCode,
      };
      const composition = { lastCompositionEndAt: compositionEndedAt.current, now: Date.now() };
      if (!shouldSendOnEnter(key, composition)) return;
      event.preventDefault();
      void submit();
    },
    onTextAreaCompositionStart: () => {
      composing.current = true;
    },
    onTextAreaCompositionEnd: () => {
      composing.current = false;
      compositionEndedAt.current = Date.now();
    },
  };
  return { body, setBody, sending, sendFailed, input, submit, keys };
}

/**
 * One comment as Raft lists it: avatar, author and short time on one line, its place (`place`)
 * and its body, nothing else. The row greys under the pointer and while its place was just jumped
 * to. Replies and reactions from the earlier model are not shown here (Raft, 2026-10-26).
 */
export function CommentRow({
  comment,
  place,
  highlighted,
}: {
  comment: AttachmentCommentView;
  place?: ReactNode;
  /** Marks the comment whose place was just jumped to, as Raft greys its row. */
  highlighted?: boolean;
}) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  return (
    <article
      className={cn(
        "-mx-2 flex min-w-0 gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-secondary",
        highlighted && "bg-secondary",
      )}
    >
      <IdentityAvatar src={comment.senderAvatarUrl} name={comment.senderName} size="xs" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold text-primary">{comment.senderName}</span>
          <time
            dateTime={comment.createdAt}
            className="shrink-0 text-xs text-tertiary tabular-nums"
          >
            {clockLabel(comment.createdAt, getLocale(), timeFormat, timeZone ?? undefined)}
          </time>
        </p>
        {place}
        <div className="message-text mt-1 text-secondary">
          <MessageBody body={comment.body} />
        </div>
      </div>
    </article>
  );
}
