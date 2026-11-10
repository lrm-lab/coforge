import { Link, useHydrated } from "@tanstack/react-router";
import { FlipForward } from "@untitledui/icons";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { MessageAttachments } from "./attachment-card";
import { ConversationIdProvider } from "./conversation-id";
import { MessageBody } from "./message-body";
import { attachmentMessageDisplayBody } from "./attachment-file-name";
import type { ForwardedMessageView } from "./message-forward";
import { forwardSourceTarget } from "./message-forward-model";
import type { MessageView } from "./message-view";

/** Where the original was, as the card's right-hand label reads it. */
function fromLabel({ sourceConversation, sourceThreadRootId }: ForwardedMessageView) {
  const thread = sourceThreadRootId !== undefined;
  if (sourceConversation.name === null) {
    return thread ? m.message_forward_from_dm_thread() : m.message_forward_from_dm();
  }
  const name = sourceConversation.name;
  return thread
    ? m.message_forward_from_channel_thread({ name })
    : m.message_forward_from_channel({ name });
}

/** An original's attachments: the ones it names, or all of the message's when it is the only one. */
function attachmentsOf(
  forwarded: ForwardedMessageView,
  attachments: MessageView["attachments"],
): MessageView["attachments"] {
  const ids = forwarded.attachmentIds;
  return ids ? attachments.filter((attachment) => ids.includes(attachment.id)) : attachments;
}

/**
 * A forwarded message's card: the frozen originals in a bordered box under the forwarder's note,
 * oldest first, one or a selection of several. The row stream, Saved, search and Activity draw it
 * for a forward, and the Forward dialog draws the same card for what it is about to send, where
 * the originals are not accessible yet. The card holds the attachments, copies of the originals',
 * each under its own original. Its "from #x" label opens the (first) original ("Open source
 * message") only where the viewer can open it now; a selection comes from one conversation.
 */
export function ForwardedMessageCard({
  forwarded,
  attachments,
}: {
  forwarded: readonly ForwardedMessageView[];
  attachments: MessageView["attachments"];
}) {
  const workspaceSlug = useWorkspaceSlug();
  const [first] = forwarded;
  if (!first) return null;
  const target = first.sourceAccessible ? forwardSourceTarget(workspaceSlug, first) : null;
  const several = forwarded.length > 1;
  return (
    <div
      data-forwarded-card
      className="mt-1 flex w-full max-w-xl min-w-0 flex-col gap-2 rounded-lg border border-secondary bg-secondary/40 p-3"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-secondary">
          <FlipForward aria-hidden="true" className="size-3.5" />
          {/* "Forwarded message" / "已转发 2 条消息": the kind of thing, lighter. The
              space is the language's own (none in Chinese), so it lives in the message. */}
          {several ? (
            <span>
              {m.message_forward_badge_several()}
              <span className="font-normal text-tertiary">
                {m.message_forward_badge_several_count({ count: forwarded.length })}
              </span>
            </span>
          ) : (
            <span>
              {m.message_forward_badge()}
              <span className="font-normal text-tertiary">{m.message_forward_badge_count()}</span>
            </span>
          )}
        </span>
        {/* As Raft's: where it came from is also the way back to it, when the viewer can open it. */}
        {target ? (
          <Link
            {...target}
            aria-label={m.message_forward_open_source()}
            className="min-w-0 truncate text-tertiary hover:text-secondary hover:underline"
          >
            {fromLabel(first)}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-tertiary">{fromLabel(first)}</span>
        )}
      </div>
      <div className={several ? "flex min-w-0 flex-col gap-3" : "contents"}>
        {forwarded.map((original, index) => (
          <ForwardedOriginal
            key={original.sourceMessageId ?? index}
            original={original}
            attachments={attachmentsOf(original, attachments)}
          />
        ))}
      </div>
    </div>
  );
}

/** One original in the card: its author's face, handle and moment, its words, its attachments. */
function ForwardedOriginal({
  original,
  attachments,
}: {
  original: ForwardedMessageView;
  attachments: MessageView["attachments"];
}) {
  const hydrated = useHydrated();
  const timeFormat = useTimeFormat();
  // The snapshot keeps the original's body as stored, an image-only send's filename placeholder
  // included; the row drops that placeholder, and so does the card.
  const body = attachmentMessageDisplayBody({ body: original.sourceBody, attachments });
  const rawBody =
    original.sourceRawBody === undefined
      ? undefined
      : attachmentMessageDisplayBody({ body: original.sourceRawBody, attachments });
  const sender = original.sourceSender;
  return (
    <div className="flex min-w-0 gap-2.5">
      {/* The author's face, as each row in the stream has one (Frank, 11-10): the server finds
          who sent the original (`forwardedSenders`); a handle it cannot place gets an initial.
          No presence dot: the card is a record of then, not who is around now. */}
      <ActorAvatar
        size="xs"
        presence={false}
        className="mt-px shrink-0"
        name={original.sourceSenderHandle}
        src={sender?.avatarUrl ?? null}
        {...(sender?.kind === "agent" ? { agentId: sender.id } : {})}
        {...(sender?.kind === "user" ? { userId: sender.id } : {})}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* As Raft draws it: the author by handle and the month, day and time; the moment does not
          age the way the row's own time does. */}
        <p className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="min-w-0 truncate font-semibold text-secondary">
            @{original.sourceSenderHandle}
          </span>
          <span aria-hidden="true" className="text-quaternary">
            ·
          </span>
          <time
            dateTime={original.sourceCreatedAt}
            suppressHydrationWarning
            className="shrink-0 text-tertiary tabular-nums"
          >
            {hydrated
              ? formatMonthDayTime(original.sourceCreatedAt, null, getLocale(), timeFormat)
              : ""}
          </time>
        </p>
        {original.sourceRawBody !== undefined && original.sourceMentions
          ? // The original's own words with their chips. A task it names is the source
            // conversation's, so no conversation is in scope to read it from: it stays `task #N`.
            rawBody && (
              <ConversationIdProvider conversationId={undefined}>
                <MessageBody body={rawBody} mentions={original.sourceMentions} />
              </ConversationIdProvider>
            )
          : body && <p className="message-markdown whitespace-pre-wrap text-primary">{body}</p>}
        <MessageAttachments attachments={attachments} />
      </div>
    </div>
  );
}
