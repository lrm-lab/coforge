import { ChevronRight, MessageSquare01 as MessageSquare } from "@untitledui/icons";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { RelativeTime } from "#src/components/ui/relative-time";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { DELETED_AGENT_AVATAR_CLASS } from "#src/features/agents/deleted-agent";
import { replyCountLabel, withUnreadCount } from "./conversation-labels";
import { useThreadBodyFormat, useThreadSummary, useThreadUnread } from "./thread-store";

/**
 * The parts of a root's row that show its thread. Each reads its own root's slice of the
 * conversation's thread store (`thread-store.tsx`), so a reply or a read in one thread
 * re-renders that root's parts and no other row.
 */

type ThreadPartProps = { rootId: string; onOpen: (rootId: string) => void };

/** The hover toolbar's thread button, with a dot while Agent replies are unread. */
export function ThreadToolbarEntry({ rootId, onOpen }: ThreadPartProps) {
  const unread = useThreadUnread(rootId);
  return (
    <span className="relative inline-flex">
      <ButtonUtility
        icon={MessageSquare}
        size="xs"
        color="tertiary"
        // The dot already shows the count, so it stays out of the tooltip; screen readers still
        // get it through the accessible name.
        tooltip={m.conversation_thread_reply()}
        aria-label={withUnreadCount(m.conversation_thread_reply(), unread)}
        onClick={() => onOpen(rootId)}
        className="p-1 *:data-icon:size-3.5"
      />
      {unread > 0 && (
        <span className="absolute -top-1 -right-1">
          <UnreadDot />
        </span>
      )}
    </span>
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

/**
 * The preview card under a root: the reply count, the unread count and the newest few replies,
 * which the thread's summary carries. System notices are stream bookkeeping, not a person
 * replying: they belong to the full thread pane, never to the preview, and a thread with only
 * notices shows no preview at all.
 */
export function ThreadPreview({ rootId, onOpen }: ThreadPartProps) {
  const summary = useThreadSummary(rootId);
  const unread = useThreadUnread(rootId);
  const formatBody = useThreadBodyFormat();
  if (!summary?.replyCount) return null;
  const label = replyCountLabel(summary.replyCount);
  return (
    // The text spans carry `message-text`, which scopes the type scale to Settings → Message font
    // size as in the message above (so `md` is the body size and `sm` the small one). The
    // avatars stay outside it: they do not change with that setting.
    <Button
      color="tertiary"
      size="sm"
      noTextPadding
      onPress={() => onOpen(rootId)}
      // Design spec: 8px above the content, 16px below it and on each side.
      className="mt-1.5 block h-auto w-full rounded-lg bg-secondary px-4 pt-2 pb-4 text-left font-normal hover:bg-secondary_hover"
      data-thread-preview=""
    >
      {/* The reply count reads in the spec's text grey; only the viewer's unread count (and the
          chevron after it) keeps the brand accent, so "something new" is the one coloured part. */}
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
        <ChevronRight aria-hidden="true" className="size-4" />
      </span>
      <span className="mt-1 flex flex-col gap-1.5">
        {/* The newest few only; the side pane holds the full thread. */}
        {summary.latestReplies.map((reply) => (
          <span key={reply.id} className="flex min-w-0 items-center gap-2">
            <Avatar
              size="xs"
              alt={reply.senderName}
              src={reply.senderAvatarUrl}
              initials={avatarInitial(reply.senderName)}
              contentClassName={
                reply.senderDeleted
                  ? DELETED_AGENT_AVATAR_CLASS
                  : avatarToneClassName(reply.senderName)
              }
              className="shrink-0"
            />
            <span className="message-text shrink-0 text-md font-medium text-primary">
              {reply.senderName}
            </span>
            <span className="message-text min-w-0 flex-1 truncate text-md text-secondary">
              {formatBody(reply.body)}
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
