import type { ChannelSignal } from "./channel-signals";
import {
  streamMovedSince,
  subscriptionGap,
  type StreamPosition,
  type SubscribedRecovery,
} from "#src/features/realtime/subscription-gap";
import {
  decodeChannelCreatedEvent,
  decodeChannelUpdatedEvent,
  decodeMessageAvailableEvent,
  type ViewerEvent,
} from "./conversation-realtime";

/**
 * Sidebar unread state for the Chat page (Slack/Discord model): a per-badge count
 * of unread top-level messages, seeded from the server's persisted read cursors and kept
 * live by realtime signals. Opening a conversation clears its badge; every list fetch
 * replaces local arithmetic with the server's own count.
 *
 * A badge key is the conversation id, for channels and direct messages alike (the directory
 * rows' own keys). Channels and direct messages arrive on separate signal channels: the
 * workspace channel carries every channel event, and each user's own channel carries only their
 * direct messages, each naming who is on the other side. A DM event counts without a listed
 * conversation, so a DM created after the last list fetch still bumps its badge live.
 *
 * Counts live alongside a per-badge sequence high-water mark (`<key>:seq`), so a late or
 * reordered event can never double-count a message the badge already reflects.
 */
export type UnreadCounts = Record<string, number>;

export type UnreadChannel = { id: string; unreadCount?: number };

/** Seeds local state from the server's list payload. */
export function seedUnreadCounts(entries: readonly UnreadChannel[]): UnreadCounts {
  const next: UnreadCounts = {};
  for (const entry of entries)
    if (entry.unreadCount && entry.unreadCount > 0) next[entry.id] = entry.unreadCount;
  return next;
}

export type UnreadEventInput = {
  conversationId: string;
  sequence: number;
  threadRootId?: string;
  /** Present on a signal of a DM with an Agent: that Agent. */
  agentId?: string;
  /** Present on a signal of a DM between members: the other member. */
  peerUserId?: string;
  /** Present on a person's message: that person. */
  senderUserId?: string;
};

/** A message the viewer wrote themself, from any page or device. */
function isOwnMessage(event: UnreadEventInput, viewerId: string | undefined) {
  return viewerId !== undefined && event.senderUserId === viewerId;
}

/**
 * Applies one `message.available.v1` event. Only a top-level message in a listed,
 * not-currently-open conversation bumps the badge: thread replies belong to their thread
 * target (reading a thread never consumes the main conversation's unread), and the open
 * conversation is being read right now. Every badge is keyed by its conversation id; a channel
 * event counts only for a listed channel, a direct-message event (it names the Agent or member on
 * the other side) always.
 */
export function applyUnreadEvent(
  current: UnreadCounts,
  event: UnreadEventInput,
  options: {
    openConversationId?: string;
    /** Every listed channel's conversation id. */
    conversations: ReadonlySet<string>;
    /** The viewer, whose own message never counts (`MessageAvailableEvent.senderUserId`). */
    viewerId?: string;
  },
): UnreadCounts {
  if (event.conversationId === options.openConversationId) return current;
  if (event.threadRootId) return current;
  const key = event.conversationId;
  const direct = event.agentId !== undefined || event.peerUserId !== undefined;
  if (!direct && !options.conversations.has(key)) return current;
  const highWater = current[`${key}:seq`] ?? 0;
  if (event.sequence <= highWater) return current;
  // The viewer's own message moves the high-water without counting, so the same message sent
  // again without a sender (a Task change re-sends its message) is not counted either.
  if (isOwnMessage(event, options.viewerId)) return { ...current, [`${key}:seq`]: event.sequence };
  return {
    ...current,
    [`${key}:seq`]: event.sequence,
    [key]: (current[key] ?? 0) + 1,
  };
}

/**
 * The Agent a DM signal names when the viewer's Agents do not know it yet (one made from an
 * action card or in another tab, writing first): its DM row only lists once they have it, so the
 * page must re-read them too. Undefined for a known Agent, a DM between members, or a channel.
 */
export function unknownAgentOf(
  event: UnreadEventInput,
  knownAgentIds: ReadonlySet<string>,
): string | undefined {
  return event.agentId !== undefined && !knownAgentIds.has(event.agentId)
    ? event.agentId
    : undefined;
}

/**
 * Which list a new message makes stale when it landed in a chat the sidebar is not showing: one
 * the viewer closed, or a DM that started after the list was read. Such a message brings the chat
 * in, so the sidebar re-reads that one list: the DM list for a DM (its signal names the Agent or
 * member on the other side), else the channel list. Thread replies and listed chats never do.
 */
export function closedConversationLists(
  event: UnreadEventInput,
  listed: ReadonlySet<string>,
  viewerId?: string,
): readonly ChatList[] {
  // The server brings a closed chat back only for someone else's message.
  if (event.threadRootId || listed.has(event.conversationId) || isOwnMessage(event, viewerId))
    return [];
  return event.agentId !== undefined || event.peerUserId !== undefined ? ["dms"] : ["channels"];
}

/**
 * Which list a top-level message makes stale in a DM the sidebar already lists: the DM list, so
 * the row shows its new last message time and preview. Incoming and the viewer's own message
 * alike (a send from another tab or device). Thread replies and channels never do; an unlisted DM
 * is `closedConversationLists`' case, so the two rules never both name the list.
 */
export function directRowRefreshLists(
  event: UnreadEventInput,
  listed: ReadonlySet<string>,
): readonly ChatList[] {
  const direct = event.agentId !== undefined || event.peerUserId !== undefined;
  if (!direct || event.threadRootId || !listed.has(event.conversationId)) return [];
  return ["dms"];
}

/**
 * Which list a top-level message makes stale in a channel the sidebar already lists: the channel
 * list, so the row shows its new last message time and preview. Incoming and the viewer's own
 * message alike (a send from another tab or device). Thread replies and DMs never do; an unlisted
 * channel is `closedConversationLists`' case, so the two rules never both name the list.
 */
export function channelRowRefreshLists(
  event: UnreadEventInput,
  listed: ReadonlySet<string>,
): readonly ChatList[] {
  const direct = event.agentId !== undefined || event.peerUserId !== undefined;
  if (direct || event.threadRootId || !listed.has(event.conversationId)) return [];
  return ["channels"];
}

/** A conversation was read: clear its badge and remember the boundary it was read to. */
export function clearUnread(
  current: UnreadCounts,
  key: string,
  readThroughSequence?: number,
): UnreadCounts {
  const boundary = readThroughSequence ?? current[`${key}:seq`];
  if (!(key in current) && boundary === undefined) return current;
  const next = { ...current };
  delete next[key];
  if (boundary !== undefined && (next[`${key}:seq`] ?? 0) < boundary) next[`${key}:seq`] = boundary;
  return next;
}

/** A viewer event that moved a read cursor, carrying the count it left. */
export type MarkedEvent = Extract<ViewerEvent, { unreadCount: number }>;

/**
 * Where a read-cursor move puts the conversation's window: its stored copy takes the cursor the
 * move carries, so the next open draws the divider where the person now is (Slack's
 * `channel_marked` `ts`), and so does the page's own window at once (`adoptNow`), except for the
 * conversation on screen, which keeps the divider it opened with until the person leaves it.
 */
export function storedCursorMove(event: MarkedEvent, openConversationId: string | undefined) {
  return {
    kind: event.type === "channel.marked.v1" ? ("channel" as const) : ("direct" as const),
    conversationId: event.conversationId,
    throughSequence: event.readThroughSequence,
    adoptNow: event.conversationId !== openConversationId,
  };
}

/**
 * The viewer's read cursor in a channel or DM moved (`channel.marked.v1`, `dm.marked.v1`): read or
 * marked unread here, in another tab or on another device. The badge takes the count the move
 * left, as Slack's `channel_marked` and `im_marked` set `unread_count`; the sequence boundary
 * stays. The chat on screen keeps no badge, like `applyUnreadEvent`.
 */
export function applyMarked(
  current: UnreadCounts,
  event: MarkedEvent,
  options: { openConversationId?: string },
): UnreadCounts {
  const key = event.conversationId;
  if (key === options.openConversationId) return current;
  if ((current[key] ?? 0) === event.unreadCount) return current;
  const next = { ...current };
  if (event.unreadCount > 0) next[key] = event.unreadCount;
  else delete next[key];
  return next;
}

/** A list the Chat page keeps: the sidebar's channel rows or DM rows, every channel's name
 * (what a body's channel links and the composer's `#` list read), or the viewer's Saved list. */
export type ChatList = "channels" | "dms" | "channelNames" | "saved";

/**
 * Which of the Chat page's lists a viewer event makes stale, for the page to re-read those alone. A
 * read carries its own count (`applyMarked`) and needs none; pins are one order across
 * channels and DMs, and a mute may be on either, so both touch both lists; a save or unsave touches only the Saved list.
 */
export function sidebarListsChangedBy(event: ViewerEvent): readonly ChatList[] {
  if ("unreadCount" in event) return [];
  if (event.type.startsWith("saved.")) return ["saved"];
  if (event.type === "pref.changed.v1") return ["channels", "dms"];
  return event.type.startsWith("dm.") ? ["dms"] : ["channels"];
}

/** A message signal, or undefined for any other publication on the viewer's channel. */
export function decodeMessageSignal(data: unknown): UnreadEventInput | undefined {
  try {
    return decodeMessageAvailableEvent(data);
  } catch {
    return undefined;
  }
}

/**
 * A channel created or changed anywhere in the Workspace (`channel.created.v1`,
 * `channel.updated.v1`), for the page to apply to its lists; undefined for anything else on the
 * Workspace channel (a message signal).
 */
export function channelSignalOf(data: unknown): ChannelSignal | undefined {
  const created = decodeChannelCreatedEvent(data);
  if (created) return created;
  try {
    return decodeChannelUpdatedEvent(data);
  } catch {
    return undefined;
  }
}

/**
 * The lists a Chat page may have missed something in once one of its two signal channels is
 * subscribed, as `subscriptionGap` reads the event: nothing when the subscribe replayed every
 * missed publication; otherwise (a first subscribe, which follows the page's own reads, or a
 * resubscribe that lost publications) every list that channel keeps live. The Workspace channel
 * carries channel messages and channel events; the viewer's own channel carries DM messages and
 * their `ViewerEvent`s.
 */
export function listsMissedBySubscribe(
  channel: "workspace" | "user",
  recovery: SubscribedRecovery,
): readonly ChatList[] {
  if (subscriptionGap(recovery) === "none") return [];
  return channel === "workspace" ? ["channels", "channelNames"] : ["channels", "dms", "saved"];
}

/**
 * Re-reads what a subscribe may have missed (`listsMissedBySubscribe`). After a resubscribe that
 * lost publications, every such list. After a first subscribe, a list `readPosition` has no answer
 * for at all, at once; any other only if the stream has moved past the position it settles to
 * (`streamMovedSince`, where none counts as moved), judged by where the stream stands for the
 * subscription once that read has settled, so a publication delivered meanwhile counts.
 */
export async function rereadMissedBySubscribe(
  channel: "workspace" | "user",
  recovery: SubscribedRecovery,
  readPosition: (list: ChatList) => Promise<StreamPosition | undefined> | undefined,
  reread: (lists: readonly ChatList[]) => void,
): Promise<void> {
  const lists = listsMissedBySubscribe(channel, recovery);
  if (subscriptionGap(recovery) !== "unrecovered") {
    if (lists.length > 0) reread(lists);
    return;
  }
  const positioned = lists.flatMap((list) => {
    const read = readPosition(list);
    return read ? [{ list, read }] : [];
  });
  const unpositioned = lists.filter((list) => !positioned.some((entry) => entry.list === list));
  if (unpositioned.length > 0) reread(unpositioned);
  await Promise.all(
    positioned.map(async ({ list, read }) => {
      if (streamMovedSince(await read, recovery.position?.())) reread([list]);
    }),
  );
}

/**
 * Coalesces sidebar re-reads: lists named before a re-read starts go into it, and lists named
 * while one is running go into a single re-read after it, so a burst of events costs at most one
 * read in flight and one queued. Each call settles once a re-read covering its lists has.
 */
export function sidebarRefreshQueue(read: (lists: ReadonlySet<ChatList>) => Promise<void>) {
  let running: Promise<void> = Promise.resolve();
  let queued: { lists: Set<ChatList>; done: Promise<void> } | undefined;
  return (lists: readonly ChatList[]): Promise<void> => {
    if (!queued) {
      const batch = new Set<ChatList>();
      const done = running.then(() => {
        queued = undefined;
        return read(batch);
      });
      running = done.catch(() => undefined);
      queued = { lists: batch, done };
    }
    for (const list of lists) queued.lists.add(list);
    return queued.done;
  };
}

/**
 * The highest top-level sequence in a loaded conversation page — the boundary "I have read
 * everything shown in the main pane". Thread replies never advance it. Shared by
 * the channel and DM routes so the two mark-read paths cannot drift.
 */
export function latestTopLevelSequence(
  messages: readonly { sequence: number; threadRootId?: string | null }[],
): number {
  return messages.reduce(
    (latest, message) => (message.threadRootId ? latest : Math.max(latest, message.sequence)),
    0,
  );
}

/**
 * Persists a conversation-level read cursor, retrying a transient failure once. Both mark-read
 * call sites used to swallow every failure with `.catch(() => {})`, so a flaky POST left the
 * cursor stuck at zero and the pane kept reopening at the same unread boundary with nothing in
 * the console to show why. One retry clears the transient case; a persistent one is logged with
 * the label of the surface that failed, so it is diagnosable from devtools.
 */
export async function persistReadCursor(
  call: () => Promise<unknown>,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await call();
      return;
    } catch (error) {
      if (attempt === 1) {
        console.warn(`[coforge] read cursor did not persist (${label})`, error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

/**
 * A loader refresh replaced the server's own counts; local arithmetic restarts from them.
 * Sequence boundaries survive the refresh, so a stale event that raced the fetch cannot
 * double-count a message the server already counted.
 *
 * `suppressKeys` names the conversation the viewer is looking at right now (the open channel or
 * DM). It keeps its boundary but loses its count, exactly like `applyUnreadEvent`: a refresh must
 * not re-raise the badge of the conversation being read. Leaving it re-seeds from the server.
 */
export function replaceUnreadCounts(
  current: UnreadCounts,
  entries: readonly UnreadChannel[],
  suppressKeys: ReadonlySet<string> = new Set<string>(),
  keepIds: ReadonlySet<string> = new Set<string>(),
): UnreadCounts {
  const boundaries: UnreadCounts = {};
  for (const entry of entries) {
    const boundary = current[`${entry.id}:seq`];
    if (boundary !== undefined) boundaries[`${entry.id}:seq`] = boundary;
  }
  const seeded = seedUnreadCounts(
    entries.map((entry) =>
      keepIds.has(entry.id) ? { id: entry.id, unreadCount: current[entry.id] ?? 0 } : entry,
    ),
  );
  for (const key of suppressKeys) delete seeded[key];
  return { ...seeded, ...boundaries };
}

/** One Chat list's rows as last seeded, and when the server sent them. */
export type SeededList = { readAt: number; rows: readonly UnreadChannel[] };

/**
 * The conversations whose live count a re-seed keeps (`replaceUnreadCounts`' `keepIds`): the rows
 * of a list not read again since the last seed, whose own count has not changed either. A row's
 * `unreadCount` is as old as its list's last read, since reading a chat moves only the live count,
 * so re-seeding from a list not read again would bring back counts already read. A list read again
 * brings the server's counts, and a row whose count changed (a mark-unread) brings its own.
 */
export function unreadIdsToKeep(
  lists: readonly SeededList[],
  last: readonly SeededList[] | undefined,
): Set<string> {
  const keep = new Set<string>();
  lists.forEach((list, index) => {
    const before = last?.[index];
    if (!before || before.readAt !== list.readAt) return;
    const counts = new Map(before.rows.map((row) => [row.id, row.unreadCount ?? 0]));
    for (const row of list.rows)
      if (counts.get(row.id) === (row.unreadCount ?? 0)) keep.add(row.id);
  });
  return keep;
}
