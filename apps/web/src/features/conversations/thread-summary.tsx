import { actionCardPreviewText } from "./action-card-preview";
import { ChevronRight, MessageSquare01 as MessageSquare } from "@untitledui/icons";

import { ThreadReplyingLine } from "#src/features/agents/replying-agents-line";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { RelativeTime } from "#src/components/ui/relative-time";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { replyCountLabel, withUnreadCount } from "./conversation-labels";
import {
  useThreadBodyFormat,
  useThreadConversationId,
  useThreadSummary,
  useThreadUnread,
} from "./thread-store";

/**
 * The parts of a root's row that show its thread. Each reads its own root's slice of the
 * conversation's thread store (`thread-store.tsx`), so a reply or a read in one thread
 * re-renders that root's parts and no other row.
 */

type ThreadPartProps = { rootId: string; onOpen: (rootId: string) => void };

/** The hover toolbar's thread button. Unread stays on the preview line and in this
 * button's accessible name; the icon itself has no dot (task #267). */
export function ThreadToolbarEntry({ rootId, onOpen }: ThreadPartProps) {
  const unread = useThreadUnread(rootId);
  return (
    <ButtonUtility
      icon={MessageSquare}
      size="xs"
      color="tertiary"
      tooltip={m.conversation_thread_reply()}
      aria-label={withUnreadCount(m.conversation_thread_reply(), unread)}
      onClick={() => onOpen(rootId)}
      className="p-1 *:data-icon:size-3.5"
    />
  );
}

/** The tap action sheet's thread row. */
export function ThreadSheetEntry({ rootId, onOpen }: ThreadPartProps) {
  const unread = useThreadUnread(rootId);
  return (
    <Button
      color="tertiary"
      size="md"
      noTextPadding
      iconLeading={MessageSquare}
      iconTrailing={unread > 0 ? <UnreadDot /> : undefined}
      aria-label={withUnreadCount(m.conversation_thread_reply(), unread)}
      onPress={() => onOpen(rootId)}
      className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
    >
      {m.conversation_thread_reply()}
    </Button>
  );
}

export function ThreadPreview({ rootId, onOpen }: ThreadPartProps) {
  const summary = useThreadSummary(rootId);
  const unread = useThreadUnread(rootId);
  const formatBody = useThreadBodyFormat();
  if (!summary?.replyCount) return null;
  const label = replyCountLabel(summary.replyCount);
  return (
    <Button
      color="tertiary"
      size="sm"
      noTextPadding
      onPress={() => onOpen(rootId)}
      className="mt-1.5 block h-auto w-full overflow-hidden rounded-lg bg-secondary px-4 pt-2 pb-4 text-left font-normal hover:bg-secondary_hover *:data-text:block *:data-text:min-w-0"
      data-thread-preview=""
    >
      <span
        className={cx(
          "message-text flex items-center gap-0.5 text-md font-medium",
          unread > 0 ? "text-brand-secondary" : "text-thread-reply-count",
        )}
      >
        <span className="text-thread-reply-count">
          {label}
          {unread > 0 && " · "}
        </span>
        {unread > 0 && m.conversation_thread_unread({ count: unread })}
        <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
      </span>
      <span className="mt-1 flex flex-col gap-1.5">
        {summary.latestReplies.map((reply) => (
          <span key={reply.id} className="flex min-w-0 items-center gap-2">
            <ActorAvatar
              presence={false}
              size="xs"
              alt={reply.senderName}
              src={reply.senderAvatarUrl}
              name={reply.senderName}
              deleted={reply.senderDeleted}
              className="shrink-0"
            />
            <span className="message-text max-w-[45%] shrink truncate text-md font-medium text-primary">
              {reply.senderName}
            </span>
            <span className="message-text min-w-0 flex-1 truncate text-md text-secondary">
              {actionCardPreviewText(reply.card) || formatBody(reply.body, reply.mentions)}
            </span>
            <RelativeTime
              value={reply.createdAt}
              plain
              className="message-text shrink-0 text-sm whitespace-nowrap text-tertiary"
            />
          </span>
        ))}
      </span>
    </Button>
  );
}

/** Under a root in the stream: its thread's preview, then which Agents are about to reply there. */
export function RootThread({ rootId, onOpen }: ThreadPartProps) {
  const conversationId = useThreadConversationId();
  return (
    <>
      <ThreadPreview rootId={rootId} onOpen={onOpen} />
      <ThreadReplyingLine conversationId={conversationId} rootId={rootId} />
    </>
  );
}
