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
import { CollapsibleBlock } from "./collapsible-message-body";
import { useExpansion } from "./message-expansion-context";
import { attachmentMessageDisplayBody } from "./attachment-file-name";
import type { ForwardedMessageView } from "./message-forward";
import { forwardSourceTarget } from "./message-forward-model";
import type { MessageView } from "./message-view";

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

function attachmentsOf(
  forwarded: ForwardedMessageView,
  attachments: MessageView["attachments"],
): MessageView["attachments"] {
  const ids = forwarded.attachmentIds;
  return ids ? attachments.filter((attachment) => ids.includes(attachment.id)) : attachments;
}

export function ForwardedMessageCard({
  forwarded,
  attachments,
  messageId,
}: {
  forwarded: readonly ForwardedMessageView[];
  attachments: MessageView["attachments"];
  messageId?: string;
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
            expansionKey={messageId === undefined ? undefined : `${messageId}:forward:${index}`}
          />
        ))}
      </div>
    </div>
  );
}

function ForwardedOriginal({
  original,
  attachments,
  expansionKey,
}: {
  original: ForwardedMessageView;
  attachments: MessageView["attachments"];
  expansionKey: string | undefined;
}) {
  const expansion = useExpansion(expansionKey);
  const hydrated = useHydrated();
  const timeFormat = useTimeFormat();
  const body = attachmentMessageDisplayBody({ body: original.sourceBody, attachments });
  const rawBody =
    original.sourceRawBody === undefined
      ? undefined
      : attachmentMessageDisplayBody({ body: original.sourceRawBody, attachments });
  const sender = original.sourceSender;
  return (
    <div className="flex min-w-0 gap-2.5">
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
          ? rawBody && (
              <ConversationIdProvider conversationId={undefined}>
                <div>
                  <CollapsibleBlock
                    measureKey={rawBody}
                    expanded={expansion.expanded}
                    collapsible={expansion.collapsible}
                    onToggleExpanded={expansion.toggle}
                  >
                    {() => <MessageBody body={rawBody} mentions={original.sourceMentions} />}
                  </CollapsibleBlock>
                </div>
              </ConversationIdProvider>
            )
          : body && (
              <div>
                <CollapsibleBlock
                  measureKey={body}
                  expanded={expansion.expanded}
                  collapsible={expansion.collapsible}
                  onToggleExpanded={expansion.toggle}
                >
                  {() => (
                    <p className="message-markdown whitespace-pre-wrap text-primary">{body}</p>
                  )}
                </CollapsibleBlock>
              </div>
            )}
        <MessageAttachments attachments={attachments} />
      </div>
    </div>
  );
}
