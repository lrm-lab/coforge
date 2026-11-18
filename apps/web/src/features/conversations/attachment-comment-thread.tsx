import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
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
import type { ChipMention } from "./message-reference-chips";
import {
  COMMENT_AUTHOR_CLASS,
  COMMENT_BODY_CLASS,
  COMMENT_FLASH_CLASS,
  COMMENT_META_CLASS,
  COMMENT_ROW_CLASS,
} from "./review-chrome";

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

function readDraft(key: string): DraftState {
  return { key, body: readComposerDraft(key), pins: readComposerDraftPins(key) };
}

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
  const wire = useMemo(() => rewriteMentionPins(body, pins), [body, pins]);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  async function submit() {
    if (!body.trim() || sending || !canComment) return;
    setSending(true);
    setSendFailed(false);
    try {
      await send(wire.body, idempotencyKey.current, wire.mentions);
      setBody("");
      idempotencyKey.current = crypto.randomUUID();
    } catch {
      setSendFailed(true);
    } finally {
      await refresh();
      setSending(false);
      focus();
    }
  }
  return { body, wire, setBody, pinMention, sending, sendFailed, submit };
}

export function CommentRow({
  comment,
  place,
  highlighted,
  plainMentions,
  viewerId,
}: {
  comment: AttachmentCommentView;
  place?: ReactNode;
  highlighted?: boolean;
  plainMentions?: Map<string, ChipMention>;
  viewerId?: string;
}) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  return (
    <article
      data-comment-id={comment.id}
      className={cn(
        COMMENT_ROW_CLASS,
        "min-w-0 rounded-lg border border-secondary transition-colors duration-150 hover:bg-primary_hover",
        highlighted && COMMENT_FLASH_CLASS,
      )}
    >
      <ActorAvatar
        presence={false}
        src={comment.senderAvatarUrl}
        name={comment.senderName}
        size="sm"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex min-h-6 min-w-0 items-center gap-2">
          <span className={COMMENT_AUTHOR_CLASS}>{comment.senderName}</span>
          <time dateTime={comment.createdAt} className={cn(COMMENT_META_CLASS, "shrink-0")}>
            {clockLabel(comment.createdAt, getLocale(), timeFormat, timeZone ?? undefined)}
          </time>
        </p>
        {place}
        <div className={cn(COMMENT_BODY_CLASS, "message-text min-w-0")}>
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
