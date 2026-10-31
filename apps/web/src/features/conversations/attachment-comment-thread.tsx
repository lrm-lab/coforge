import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { clockLabel } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { cn } from "#src/lib/utils";
import { getLocale } from "#src/paraglide/runtime";
import type { AttachmentCommentView } from "#src/server/attachments/attachment-comments.server";
import { loadAttachmentComments } from "./attachment-comments.functions";
import {
  attachmentCommentDraftKey,
  readComposerDraft,
  readComposerDraftPins,
  writeComposerDraft,
  writeComposerDraftPins,
} from "./composer-draft";
import { attachmentCommentsQueryKey } from "./conversation-query-keys";
import type { Mentionable } from "./mention-text";
import {
  addMentionPin,
  mentionPinFor,
  pinsInText,
  rewriteMentionPins,
  type MentionPin,
} from "./mention-pins";
import { MessageBody } from "./message-body";
import type { ChipMention } from "./message-markdown";

/**
 * An attachment's comments (`attachmentCommentsQueryKey`), paged backwards from the newest and read
 * again every few seconds; `comments` runs oldest first across the loaded pages. Opening a file
 * always reads them again: whether the viewer may comment follows their membership, which can
 * have changed since they were cached.
 */
export function useCommentPages(attachmentId: string) {
  const query = useInfiniteQuery({
    queryKey: attachmentCommentsQueryKey(attachmentId),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      loadAttachmentComments({ data: { attachmentId, beforeSequence: pageParam } }),
    getNextPageParam: (page) => (page.hasOlder ? page.comments[0]?.sequence : undefined),
    refetchInterval: 5_000,
    refetchOnMount: "always",
  });
  const comments = useMemo(
    () => (query.data ? [...query.data.pages].reverse().flatMap((page) => page.comments) : []),
    [query.data],
  );
  return { query, comments };
}

type DraftState = { key: string; body: string; pins: readonly MentionPin[] };

/** The draft saved on this device under `key`: its text and who its names were picked to mean. */
function readDraft(key: string): DraftState {
  return { key, body: readComposerDraft(key), pins: readComposerDraftPins(key) };
}

/**
 * The comment field's draft and sending state. The draft is kept on this device per file, as a
 * conversation's is (`composer-draft.ts`), so leaving the preview loses nothing; so are the people
 * its `@name`s were picked to mean (`pinMention`), kept in step with its text as the composer does
 * (`mention-pins.ts`). `send` posts it, its names written as handles and its pinned members as
 * `mentions`; `refresh` reads the lists it changes again, whether or not it was posted. The field
 * keeps focus throughout (`focus`, given the field after a send).
 */
export function useCommentDraft(
  attachmentId: string,
  canComment: boolean,
  send: (
    body: string,
    idempotencyKey: string,
    mentions: MentionSelectorInput[],
  ) => Promise<unknown>,
  refresh: () => Promise<unknown>,
  focus: () => void,
) {
  const draftKey = attachmentCommentDraftKey(attachmentId);
  // The draft read for the file shown: another file reads its own, not this one's.
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const shown = useMemo(
    () => (draft.key === draftKey ? draft : readDraft(draftKey)),
    [draft, draftKey],
  );
  const { body, pins } = shown;
  useEffect(() => {
    writeComposerDraft(draftKey, body);
    writeComposerDraftPins(draftKey, pins);
  }, [draftKey, body, pins]);
  // A pick adds its pin and then writes its name: each change builds on the one before it, and
  // the text keeps only the pins whose names it still holds.
  const change = (next: (current: DraftState) => Omit<DraftState, "key">) =>
    setDraft((current) => ({
      key: draftKey,
      ...next(current.key === draftKey ? current : readDraft(draftKey)),
    }));
  const setBody = (value: string) =>
    change((current) => ({ body: value, pins: pinsInText(value, current.pins) }));
  const pinMention = (mention: Mentionable) =>
    change((current) => ({
      body: current.body,
      pins: addMentionPin(current.pins, mentionPinFor(mention)),
    }));
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  // One key per send attempt chain: a retry of the same submit reuses it (the server dedupes on
  // it), and a successful send mints the next draft's.
  const idempotencyKey = useRef(crypto.randomUUID());
  async function submit() {
    if (!body.trim() || sending || !canComment) return;
    setSending(true);
    setSendFailed(false);
    try {
      const wire = rewriteMentionPins(body, pins);
      await send(wire.body, idempotencyKey.current, wire.mentions);
      setBody("");
      idempotencyKey.current = crypto.randomUUID();
    } catch {
      setSendFailed(true);
    } finally {
      await refresh();
      setSending(false);
      // The post button disables itself once the draft is cleared, which drops focus to the page
      // (and the dialog stops hearing Escape); give it back to the field.
      focus();
    }
  }
  return { body, setBody, pinMention, sending, sendFailed, submit };
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
  plainMentions,
  viewerId,
}: {
  comment: AttachmentCommentView;
  place?: ReactNode;
  /** Marks the comment whose place was just jumped to, as Raft greys its row. */
  highlighted?: boolean;
  /** The members a plain `@handle` in the body names, and the viewer, as a message row's body
   * reads them. */
  plainMentions?: Map<string, ChipMention>;
  viewerId?: string;
}) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  return (
    // The message row's shape at the panel's width: its avatar, sender line, body type and hover.
    <article
      data-comment-id={comment.id}
      className={cn(
        "flex min-w-0 gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-message-hover",
        highlighted && "bg-tertiary",
      )}
    >
      <IdentityAvatar src={comment.senderAvatarUrl} name={comment.senderName} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-h-5 min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-primary">{comment.senderName}</span>
          <time
            dateTime={comment.createdAt}
            className="shrink-0 text-xs text-tertiary tabular-nums"
          >
            {clockLabel(comment.createdAt, getLocale(), timeFormat, timeZone ?? undefined)}
          </time>
        </p>
        {place}
        <div className="message-text min-w-0 text-md text-primary [overflow-wrap:anywhere]">
          <MessageBody
            body={comment.body}
            mentions={comment.mentions}
            plainMentions={plainMentions}
            viewerId={viewerId}
          />
        </div>
      </div>
    </article>
  );
}
