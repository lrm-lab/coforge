import { Link, useHydrated } from "@tanstack/react-router";
import { FlipForward } from "@untitledui/icons";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { MessageAttachments } from "./attachment-card";
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

/**
 * A forwarded message's card: the frozen original in a bordered box under the forwarder's note.
 * The row stream, Saved, search and Activity draw it for a forward, and the Forward dialog draws
 * the same card for what it is about to send, where the original is not accessible yet. The
 * card holds the attachments, copies of the original's. Its "from #x" label opens the original
 * ("Open source message") only where the viewer can open it now.
 */
export function ForwardedMessageCard({
  forwarded,
  attachments,
}: {
  forwarded: ForwardedMessageView;
  attachments: MessageView["attachments"];
}) {
  const workspaceSlug = useWorkspaceSlug();
  const hydrated = useHydrated();
  const timeFormat = useTimeFormat();
  const target = forwarded.sourceAccessible ? forwardSourceTarget(workspaceSlug, forwarded) : null;
  // The snapshot keeps the original's body as stored, an image-only send's filename placeholder
  // included; the row drops that placeholder, and so does the card.
  const body = attachmentMessageDisplayBody({ body: forwarded.sourceBody, attachments });
  return (
    <div
      data-forwarded-card
      className="mt-1 flex w-full max-w-xl min-w-0 flex-col gap-2 rounded-lg border border-secondary bg-secondary/40 p-3"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-secondary">
          <FlipForward aria-hidden="true" className="size-3.5" />
          <span>
            {m.message_forward_badge()}
            {/* Raft's "Forwarded message": the kind of thing, lighter. The space is the
                language's own (none in Chinese), so it lives in the message. */}
            <span className="font-normal text-tertiary">{m.message_forward_badge_count()}</span>
          </span>
        </span>
        {/* As Raft's: where it came from is also the way back to it, when the viewer can open it. */}
        {target ? (
          <Link
            {...target}
            aria-label={m.message_forward_open_source()}
            className="min-w-0 truncate text-tertiary hover:text-secondary hover:underline"
          >
            {fromLabel(forwarded)}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-tertiary">{fromLabel(forwarded)}</span>
        )}
      </div>
      {/* As Raft draws it: the author by handle and the month, day and time, no picture; the
          snapshot keeps no avatar, and the moment does not age the way the row's own time does. */}
      <p className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="min-w-0 truncate font-semibold text-secondary">
          @{forwarded.sourceSenderHandle}
        </span>
        <span aria-hidden="true" className="text-quaternary">
          ·
        </span>
        <time
          dateTime={forwarded.sourceCreatedAt}
          suppressHydrationWarning
          className="shrink-0 text-tertiary tabular-nums"
        >
          {hydrated
            ? formatMonthDayTime(forwarded.sourceCreatedAt, null, getLocale(), timeFormat)
            : ""}
        </time>
      </p>
      {body && <p className="message-markdown whitespace-pre-wrap text-primary">{body}</p>}
      <MessageAttachments attachments={attachments} />
    </div>
  );
}
