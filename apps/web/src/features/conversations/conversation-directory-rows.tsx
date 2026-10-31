import { Hash01 as Hash } from "@untitledui/icons";

import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";
import {
  channelMentionShown,
  channelPreviewLine,
  type ChannelPreviewSender,
} from "./channel-preview-line";
import type { ChatSection } from "./chat-section.schemas";
import { collageLayout } from "./collage-layout";
import { ConversationRow } from "./conversation-row";
import { ConversationRowMenu } from "./conversation-row-menu";
import { DirectAgentAvatar } from "./direct-agent-avatar";
import { GroupAvatar, type GroupAvatarMember } from "./group-avatar";
import { lastMessageTime } from "./last-message-time";
import type { DirectRow } from "./sidebar-rows";
import { useUnreadCount } from "./unread-store";

export type DirectoryChannel = {
  id: string;
  name: string;
  joined: boolean;
  /** The member muted this channel; its unread badge degrades to a bare dot. */
  muted?: boolean;
  /** The member pinned this row; it moves to the Pinned section and its menu item reads "Unpin". */
  pinned: boolean;
  /** Where the row sits in the Pinned section, among the member's pinned channels and DMs. */
  pinSortOrder: number | null;
  /** The channel's last message, or `null` while it has none (the row then shows its name only). */
  lastMessage: { createdAt: string; preview: string; sender: ChannelPreviewSender } | null;
  /** Up to six members: fetched so the group avatar can tell when to show "…" (it draws at most four). */
  members: readonly GroupAvatarMember[];
  /** The viewer is @mentioned in this channel. */
  mentioned: boolean;
};

/** A DM row as the directory shows it: its row, the name it goes by, and its live Agent when it is
 * one with an Agent. */
export type DirectEntry = DirectRow & { name: string; agent?: LiveAgent; self: boolean };

/** What every row's menu offers beside its own actions: the viewer's Chat sections to move it to,
 * and where a section change that failed goes to be retried. */
export type DirectoryRowMenu = {
  sections: readonly ChatSection[];
  sectionsReady: boolean;
  onSectionError: (retry: () => Promise<void>, sectionId?: string) => void;
};

/** When a row's last message was sent, in the viewer's own clock and time zone; null without one. */
function useLastMessageTime(createdAt: string | null | undefined) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  return createdAt
    ? lastMessageTime(createdAt, { now: new Date(), locale: getLocale(), timeZone, timeFormat })
    : null;
}

/** A channel's row in the Chat directory, inside its menu; it alone renders when its unread count
 * moves. */
export function ChannelDirectoryRow({
  channel,
  current,
  menu,
}: {
  channel: DirectoryChannel;
  current: boolean;
  menu: DirectoryRowMenu;
}) {
  const unreadCount = useUnreadCount(channel.id);
  const { lastMessage } = channel;
  const time = useLastMessageTime(lastMessage?.createdAt);
  return (
    <ConversationRowMenu
      target={{ kind: "channel", ...channel, muted: channel.muted === true }}
      {...menu}
    >
      <ConversationRow
        target={{ channelId: channel.id }}
        current={current}
        card
        pinned={channel.pinned}
        muted={!channel.joined || channel.muted}
        unreadCount={unreadCount}
        label={`#${channel.name}`}
        lastMessage={{
          time,
          preview: lastMessage
            ? channelPreviewLine({
                sender: lastMessage.sender,
                preview: lastMessage.preview,
                youLabel: m.conversation_you(),
              })
            : null,
          mentioned: channelMentionShown({ mentioned: channel.mentioned, unreadCount }),
        }}
        icon={
          collageLayout(channel.members.length).length > 0 ? (
            <GroupAvatar members={channel.members} />
          ) : (
            <span className="flex size-5 items-center justify-center">
              <Hash
                aria-hidden="true"
                className={cx("size-4", current ? "text-brand-secondary" : "text-tertiary")}
              />
            </span>
          )
        }
      >
        {channel.name}
      </ConversationRow>
    </ConversationRowMenu>
  );
}

/** A direct message's row in the Chat directory, inside its menu; it alone renders when its unread
 * count moves. */
export function DirectDirectoryRow({
  entry: { conversationId, peer, pinned, muted, name, agent, self, ...entry },
  current,
  menu,
}: {
  entry: DirectEntry;
  current: boolean;
  menu: DirectoryRowMenu;
}) {
  const unreadCount = useUnreadCount(conversationId);
  const time = useLastMessageTime(entry.lastMessageAt);
  return (
    <ConversationRowMenu
      target={{ kind: "direct", conversationId, pinned, muted: muted === true }}
      {...menu}
    >
      <ConversationRow
        target={{ dmId: conversationId }}
        current={current}
        card
        pinned={pinned}
        muted={muted}
        unreadCount={unreadCount}
        label={self ? m.conversation_dm_self_name({ name }) : name}
        lastMessage={{
          time,
          preview: entry.lastMessagePreview,
        }}
        icon={
          agent ? (
            <DirectAgentAvatar agent={agent} />
          ) : peer.kind === "people" ? (
            <MemberAvatar
              size="sm"
              className="avatar-dm"
              userId={peer.userId}
              name={name}
              src={peer.avatarUrl}
            />
          ) : null
        }
      >
        {name}
        {self && <span className="text-quaternary">{m.conversation_dm_self_suffix()}</span>}
      </ConversationRow>
    </ConversationRowMenu>
  );
}
