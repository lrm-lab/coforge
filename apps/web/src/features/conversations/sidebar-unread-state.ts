import { UNREAD_COUNT_SHOWN_MAX } from "#src/lib/unread-count";

export function formatUnreadCap(count: number): string {
  return count > UNREAD_COUNT_SHOWN_MAX ? `${UNREAD_COUNT_SHOWN_MAX}+` : String(count);
}

export type SidebarRowIndicators = {
  bold: boolean;
  showMention: boolean;
  unreadLabel: string | null;
  threadLabel: string | null;
  subduedCapsule: boolean;
  showManualDot: boolean;
};

export type SidebarRowIndicatorInput =
  | {
      kind: "channel";
      joined: boolean;
      muted?: boolean;
      unreadCount?: number;
      unreadThreadCount?: number;
      mentioned?: boolean;
      threadMentioned?: boolean;
      markedUnread?: boolean;
    }
  | {
      kind: "direct";
      muted?: boolean;
      unreadCount?: number;
      markedUnread?: boolean;
    };

export function sidebarRowIndicators(input: SidebarRowIndicatorInput): SidebarRowIndicators {
  const unreadCount = input.unreadCount ?? 0;
  const markedUnread = input.markedUnread === true;
  if (input.kind === "direct") {
    const muted = input.muted === true;
    const hasUnread = unreadCount > 0 || markedUnread;
    return {
      bold: !muted && hasUnread,
      showMention: false,
      unreadLabel: unreadCount > 0 ? formatUnreadCap(unreadCount) : null,
      threadLabel: null,
      subduedCapsule: muted,
      showManualDot: unreadCount === 0 && markedUnread,
    };
  }
  const mutedOrUnjoined = !input.joined || input.muted === true;
  const unreadThreadCount = input.joined ? (input.unreadThreadCount ?? 0) : 0;
  const hasUnread = unreadCount > 0 || unreadThreadCount > 0 || markedUnread;
  return {
    bold: input.joined && !input.muted && hasUnread,
    showMention: input.joined && Boolean(input.mentioned || input.threadMentioned),
    unreadLabel: unreadCount > 0 ? formatUnreadCap(unreadCount) : null,
    threadLabel: unreadThreadCount > 0 ? formatUnreadCap(unreadThreadCount) : null,
    subduedCapsule: mutedOrUnjoined,
    showManualDot: input.joined && unreadCount === 0 && unreadThreadCount === 0 && markedUnread,
  };
}

export function channelHasAnyUnread(row: {
  unreadCount?: number;
  unreadThreadCount?: number;
  markedUnread?: boolean;
}): boolean {
  return (
    (row.unreadCount ?? 0) > 0 || (row.unreadThreadCount ?? 0) > 0 || row.markedUnread === true
  );
}

export function directHasAnyUnread(row: { unreadCount?: number; markedUnread?: boolean }): boolean {
  return (row.unreadCount ?? 0) > 0 || row.markedUnread === true;
}

export type ChannelUnreadRowFields = {
  unreadCount: number;
  mentioned: boolean;
  markedUnread: boolean;
  unreadThreadCount: number;
  threadMentioned: boolean;
};

export type MarkedEventUnreadPayload = {
  type: "channel.marked.v1" | "dm.marked.v1";
  workspaceId: string;
  conversationId: string;
  unreadCount: number;
  readThroughSequence: number;
  markedUnread?: boolean;
  mentioned?: boolean;
  unreadThreadCount?: number;
  threadMentioned?: boolean;
};

export function applyMarkedUnreadFields(
  _current: ChannelUnreadRowFields,
  event: MarkedEventUnreadPayload,
  options: { isOpenChannel: boolean },
): ChannelUnreadRowFields {
  const unreadThreadCount = event.unreadThreadCount ?? 0;
  const threadMentioned = event.threadMentioned === true;
  if (options.isOpenChannel) {
    return {
      unreadCount: 0,
      mentioned: false,
      markedUnread: false,
      unreadThreadCount,
      threadMentioned,
    };
  }
  return {
    unreadCount: event.unreadCount,
    mentioned: event.mentioned === true,
    markedUnread: event.markedUnread === true,
    unreadThreadCount,
    threadMentioned,
  };
}

export function applyActivityUnreadFields(
  current: Pick<ChannelUnreadRowFields, "mentioned" | "unreadThreadCount" | "threadMentioned">,
  event: {
    conversationId: string;
    threadRootId?: string;
    mentioned?: boolean;
    unreadThreadCount?: number;
    threadMentioned?: boolean;
  },
  options: {
    isOpenChannel: boolean;
    openThreadRootId?: string;
    isOwnMessage: boolean;
  },
): Pick<ChannelUnreadRowFields, "mentioned" | "unreadThreadCount" | "threadMentioned"> {
  if (event.threadRootId) {
    if (event.unreadThreadCount === undefined) return current;
    if (options.isOpenChannel && options.openThreadRootId === event.threadRootId) return current;
    return {
      mentioned: current.mentioned,
      unreadThreadCount: event.unreadThreadCount,
      threadMentioned: event.threadMentioned === true,
    };
  }
  if (options.isOpenChannel || options.isOwnMessage || !event.mentioned) return current;
  return {
    ...current,
    mentioned: true,
  };
}
