import { memo, type Ref } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { BellOff01, Check, Hash01, Mail01 } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorName } from "#src/features/avatars/actor-name";
import { ChannelGlyph, ChannelTitle } from "#src/features/conversations/channel-name";
import { collageLayout } from "#src/features/conversations/collage-layout";
import { GroupAvatar } from "#src/features/conversations/group-avatar";
import { MessagePreview } from "#src/features/conversations/message-preview";
import { actionCardPreviewText } from "#src/features/conversations/action-card-preview";
import { systemNoticeText } from "#src/features/conversations/system-notice-text";
import { cn } from "#src/lib/utils";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { m } from "#src/paraglide/messages";
import type { ActivityConversationItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { activityChatLink, activityOpenTarget } from "./activity-open-target";
import { activityRowPlace } from "./activity-row-place";
import {
  ActivityDoneCheck,
  ActivityMentionBadge,
  activityRowMetaFadeClass,
  ActivityRowTime,
  ActivityRowTitle,
  ActivityUnreadCount,
  ActivityUnreadDot,
  NARROW_HIDDEN,
  useActivityRowShortcuts,
} from "./activity-row-parts";
import type { ActivityItemActions } from "./use-activity-item-actions";

export const ACTIVITY_ROW_ITEM_CLASS = "group relative";

export const ACTIVITY_ROW_LINK_CLASS =
  "relative flex items-center gap-3 rounded-lg px-2.5 py-2.5 outline-focus-ring transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2";

function Preview({ message }: { message: ActivityConversationItem["latest"] }) {
  if (message.system) return <>{systemNoticeText(message)}</>;
  const cardText = actionCardPreviewText(message.card);
  if (cardText) return <>{cardText}</>;
  if (message.body) return <MessagePreview body={message.body} mentions={message.mentions} />;
  if (message.forwarded?.[0])
    return <>{m.message_forward_preview({ text: message.forwarded[0].sourceBody })}</>;
  return <>{message.attachments[0]?.fileName ?? ""}</>;
}

export const ActivityInboxRow = memo(function ActivityInboxRow({
  item,
  filter,
  actions,
  viewerId,
  current,
  tabStop,
  onOpen,
  clock = false,
  ref,
}: {
  item: ActivityConversationItem;
  filter: ActivityInboxFilter;
  actions: ActivityItemActions;
  viewerId: string;
  current: boolean;
  tabStop: boolean;
  onOpen: (target: HostedConversationTarget) => void;
  clock?: boolean;
  ref?: Ref<HTMLLIElement>;
}) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const { read: readShortcut, done: doneShortcut } = useActivityRowShortcuts();
  const target = activityOpenTarget(item);
  const link = activityChatLink(workspaceSlug, target);
  const href = router.buildLocation(link).publicHref;
  const unread = item.unreadCount > 0;
  const time = <ActivityRowTime value={item.latest.createdAt} clock={clock} current={current} />;
  const { place, thread, task } = item;
  const taskMeta = task ?? thread?.task;
  const title =
    place.kind === "channel"
      ? place.channelName
      : place.peer.kind === "people" && place.peer.userId === viewerId
        ? m.conversation_dm_self_name({ name: place.peer.displayName })
        : place.peer.displayName;
  const rowPlace = activityRowPlace(item);
  const placeLabel =
    rowPlace?.kind === "attachment" ? (
      m.activity_inbox_attachment_comment({ fileName: rowPlace.fileName })
    ) : rowPlace && place.kind === "channel" ? (
      <ChannelTitle
        name={title}
        visibility={place.visibility}
        hash={false}
        lockClassName="size-3.5"
      />
    ) : (
      rowPlace && (place.kind === "direct" && place.peer.kind === "agent" ? `@${title}` : title)
    );
  const { latest } = item;
  const sender =
    latest.senderKind === "system" ? (
      m.activity_inbox_system_sender()
    ) : (
      <ActorName
        inline
        actor={{
          kind: latest.senderKind,
          id: latest.senderKind === "agent" ? latest.senderAgentId : latest.senderUserId,
          name: latest.senderName,
          avatarUrl: latest.senderAvatarUrl,
          deleted: latest.senderDeleted,
        }}
      />
    );

  function handleAction(key: unknown) {
    if (key === "read") actions.read(item);
    else if (key === "unread") actions.unread(item);
    else if (key === "done") actions.done(item);
    else if (key === "unfollow") actions.unfollow(item);
  }

  return (
    <li
      ref={ref}
      data-activity-row={item.key}
      className={cn(ACTIVITY_ROW_ITEM_CLASS, "select-none [-webkit-touch-callout:none]")}
    >
      <Dropdown.Root trigger="contextMenu">
        <AriaLink
          href={href}
          aria-current={current ? "true" : undefined}
          onPress={(event) => {
            const readByPane = !current && !item.task && !item.mentionAction && !isModified(event);
            if (unread && !readByPane) actions.read(item);
          }}
          render={(props) =>
            "href" in props ? (
              <Link
                {...props}
                {...link}
                tabIndex={tabStop ? 0 : -1}
                onClick={(event) => {
                  if (event.button === 0 && !isModified(event)) {
                    event.preventDefault();
                    onOpen(target);
                  }
                  props.onClick?.(event);
                }}
              />
            ) : (
              <span {...props} />
            )
          }
          className={cn(
            ACTIVITY_ROW_LINK_CLASS,
            current ? "bg-active" : "group-hover:bg-primary_hover focus-visible:bg-primary_hover",
          )}
        >
          <span className="relative flex shrink-0">
            <ActivityItemIcon item={item} />
            {unread && <ActivityUnreadDot current={current} />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              {taskMeta && (
                <span className="shrink-0 text-sm text-quaternary tabular-nums">
                  #{taskMeta.number}
                  {thread?.task?.ownerName ? (
                    <span className={cn(NARROW_HIDDEN, "ms-1")}>
                      <ActorName
                        inline
                        actor={{
                          kind: thread.task.ownerFace?.kind ?? "user",
                          id: thread.task.ownerFace?.id,
                          name: thread.task.ownerName,
                          avatarUrl: thread.task.ownerFace?.avatarUrl,
                          deleted: thread.task.ownerDeleted,
                        }}
                      />
                    </span>
                  ) : null}
                </span>
              )}
              <span className="flex min-w-0 flex-1">
                <ActivityRowTitle unread={unread}>
                  {task ? (
                    task.title
                  ) : thread ? (
                    <Preview message={thread.root} />
                  ) : place.kind === "channel" ? (
                    <ChannelTitle name={title} visibility={place.visibility} hash={false} />
                  ) : (
                    title
                  )}
                </ActivityRowTitle>
              </span>
              {time}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm [&_[data-mention-label]]:bg-transparent [&_[data-mention-label]]:px-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit",
                  unread ? "text-tertiary" : "text-quaternary",
                )}
              >
                {placeLabel && <span className="me-1.5 text-quaternary">{placeLabel}</span>}
                {sender}: <Preview message={item.latest} />
              </span>
              <ActivityItemStatus item={item} filter={filter} current={current} />
            </span>
          </span>
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu aria-label={m.activity_inbox_menu_label()} onAction={handleAction}>
            {unread ? (
              <Dropdown.Item
                key="read"
                id="read"
                icon={Mail01}
                label={m.activity_inbox_mark_read()}
                shortcut={readShortcut}
                selectionIndicator="none"
              />
            ) : thread || task ? null : (
              <Dropdown.Item
                key="unread"
                id="unread"
                icon={Mail01}
                label={m.conversation_menu_mark_unread()}
                shortcut={readShortcut}
                selectionIndicator="none"
              />
            )}
            <Dropdown.Item
              id="done"
              icon={Check}
              label={m.activity_inbox_menu_done()}
              shortcut={doneShortcut}
              selectionIndicator="none"
            />
            {(task || (thread && place.kind === "channel")) && (
              <Dropdown.Item
                id="unfollow"
                icon={BellOff01}
                label={task ? m.tasks_unfollow() : m.conversation_thread_unfollow()}
                selectionIndicator="none"
              />
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ActivityDoneCheck tabStop={tabStop} current={current} onDone={() => actions.done(item)} />
    </li>
  );
});

export function ActivityItemIcon({ item }: { item: ActivityConversationItem }) {
  const { place } = item;
  if (place.kind === "direct")
    return place.peer.kind === "agent" ? (
      <ActorAvatar
        size="sm"
        presence
        agentId={place.peer.agentId}
        name={place.peer.displayName}
        src={place.peer.avatarUrl}
      />
    ) : (
      <ActorAvatar
        presence
        size="sm"
        userId={place.peer.userId}
        name={place.peer.displayName}
        src={place.peer.avatarUrl}
      />
    );
  if (place.kind === "channel" && collageLayout(place.members.length).length > 0)
    return (
      <span className="flex shrink-0">
        <GroupAvatar members={place.members} className="avatar-group-sm" />
      </span>
    );
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-tertiary">
      {place.kind === "channel" ? (
        <ChannelGlyph
          visibility={place.visibility}
          aria-hidden="true"
          className="size-4 text-fg-quaternary"
        />
      ) : (
        <Hash01 aria-hidden="true" className="size-4 text-fg-quaternary" />
      )}
    </span>
  );
}

function ActivityItemStatus({
  item,
  filter,
  current,
}: {
  item: ActivityConversationItem;
  filter: ActivityInboxFilter;
  current: boolean;
}) {
  const showMention = filter !== "mentions" && item.unreadMention;
  if (!showMention && item.unreadCount === 0) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", activityRowMetaFadeClass(current))}>
      {showMention && <ActivityMentionBadge />}
      {item.unreadCount > 0 && <ActivityUnreadCount count={item.unreadCount} />}
    </span>
  );
}

function isModified(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}
