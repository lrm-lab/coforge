import { z } from "zod";
import {
  publicationData,
  publicationDataOrUndefined,
} from "#src/features/realtime/publication-data";
import { streamPositionSchema } from "#src/features/realtime/subscription-gap";
export const conversationRealtimeChannel = (conversationId: string) => `chat:${conversationId}`;

/**
 * Workspace-level signal fan-out for conversation activity. Carries the same
 * versioned `message.available.v1` payloads as `chat:<conversationId>`, but
 * one subscription per open Workspace keeps the sidebar unread counts live
 * without holding a per-conversation subscription for every channel in the
 * list. It also carries a public channel's `channel.created.v1` and `channel.updated.v1`, so the
 * sidebar lists a created, renamed, deleted or archived channel from the event, and `task.changed.v1` (`features/tasks/task-realtime.ts`), so an open
 * Tasks page updates the rows a Task write changed, and `workspace.deleted.v1`
 * (`features/workspaces/workspace-realtime.ts`), so every open page leaves a deleted Workspace. Authorization mirrors the status/activity workspace channels: only
 * Workspace members' pages may hold it (the subscribe proxy checks).
 */
export const workspaceConversationChannel = (workspaceId: string) =>
  `chat:workspace:${workspaceId}`;

/**
 * The viewer's own direct-message signal channel. A DM event is published here (and on its
 * conversation channel) instead of the workspace channel, so direct-message metadata never
 * reaches every Workspace member; each publication names who is on the other side, which is how
 * the sidebar tells a DM's event from a channel's. It also carries the viewer's own
 * `ViewerEvent`s (their reads, joins, closes, mutes, pins and saves, wherever they made them), and
 * the channel events and Task changes of the private channels they are in, which never reach the
 * Workspace channel, and the changes of the Records reports they may read (`record-realtime.ts`).
 */
export const userConversationChannel = (userId: string) => `chat:user:${userId}`;

export type MessageAvailableEvent = {
  type: "message.available.v1";
  conversationId: string;
  messageId: string;
  sequence: number;
  /** The message's Workspace, so workspace-channel subscribers can scope the event. */
  workspaceId?: string;
  /** Set only for a thread reply: reading a thread consumes thread unread, never channel unread. */
  threadRootId?: string;
  /** Set only for a direct message with an Agent: that Agent. */
  agentId?: string;
  /**
   * Set only on a member's own signal channel for a direct conversation between people: the
   * other member (the member themself in their own conversation).
   */
  peerUserId?: string;
  /**
   * Set only for a message a person sent from the browser: the send's idempotency key
   * (`idempotencyKey`). The sender's own page shows the message greyed the moment it is submitted and
   * uses this to replace that pending copy with the real message, even when this signal outruns
   * the send's own response. Meaningless to anyone else, who ignores it.
   */
  idempotencyKey?: string;
  /**
   * The person who wrote the message, as Slack's `message` event names its `user`; absent for an
   * Agent's or a system message, and from an older server. A person's own pages never count their
   * own message unread (the server's count never does), wherever they sent it from.
   */
  senderUserId?: string;
};

export function decodeMessageAvailableEvent(input: unknown): MessageAvailableEvent {
  const value = publicationData(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const conversationId = Reflect.get(value, "conversationId");
  const messageId = Reflect.get(value, "messageId");
  const sequence = Reflect.get(value, "sequence");
  const workspaceId = Reflect.get(value, "workspaceId");
  const threadRootId = Reflect.get(value, "threadRootId");
  const agentId = Reflect.get(value, "agentId");
  const peerUserId = Reflect.get(value, "peerUserId");
  const idempotencyKey = Reflect.get(value, "idempotencyKey");
  const senderUserId = Reflect.get(value, "senderUserId");
  if (
    type !== "message.available.v1" ||
    typeof conversationId !== "string" ||
    !conversationId ||
    typeof messageId !== "string" ||
    !messageId ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    (workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId)) ||
    (threadRootId !== undefined && (typeof threadRootId !== "string" || !threadRootId)) ||
    (agentId !== undefined && (typeof agentId !== "string" || !agentId)) ||
    (peerUserId !== undefined && (typeof peerUserId !== "string" || !peerUserId)) ||
    (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey)) ||
    (senderUserId !== undefined && (typeof senderUserId !== "string" || !senderUserId))
  )
    throw new Error("invalid conversation event");
  return {
    type,
    conversationId,
    messageId,
    sequence,
    ...(workspaceId ? { workspaceId } : {}),
    ...(threadRootId ? { threadRootId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(peerUserId ? { peerUserId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(senderUserId ? { senderUserId } : {}),
  };
}

/** A member's top-level read position moved forward in this conversation (a person or an Agent),
 * so the viewer's own messages up to it read as seen. */
const conversationReadEvent = z.object({
  type: z.literal("conversation.read.v1"),
  conversationId: z.string().min(1),
  memberId: z.string().min(1),
  readThroughSequence: z.number().int().nonnegative(),
});

export type ConversationReadEvent = z.infer<typeof conversationReadEvent>;

export function decodeConversationReadEvent(value: unknown): ConversationReadEvent | undefined {
  return decodeJsonPublication(conversationReadEvent, value);
}

/**
 * An in-page notification signal (Frank, 2026-09-23): while a CoForge tab is open, the page shows
 * the OS notification itself from this realtime event instead of relying on Web Push, since Google
 * push services are unreachable from mainland-China staging and clients. It carries
 * no message text — the bodiless-event rule applies here too — so the browser
 * fetches title/body/url over authenticated HTTPS (`getMessageNotification`) before it can show
 * anything. Published only to the recipient's own `chat:user:<user_id>` channel.
 */
export type NotificationAvailableEvent = {
  type: "notification.available.v1";
  messageId: string;
  workspaceId: string;
};

export function decodeNotificationAvailableEvent(input: unknown): NotificationAvailableEvent {
  const value = publicationData(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const messageId = Reflect.get(value, "messageId");
  const workspaceId = Reflect.get(value, "workspaceId");
  if (
    type !== "notification.available.v1" ||
    typeof messageId !== "string" ||
    !messageId ||
    typeof workspaceId !== "string" ||
    !workspaceId
  )
    throw new Error("invalid conversation event");
  return { type, messageId, workspaceId };
}

/**
 * A membership-change signal for one conversation (join, leave, add, remove): a push in the
 * IM style, telling an open conversation its member directory is stale. It carries no member
 * payload — the client refetches the directory it already knows how to load — and only goes
 * to the conversation's own channel: the sidebar does not render the composer's candidates.
 */
export type MemberChangedEvent = {
  type: "member.changed.v1";
  conversationId: string;
  workspaceId?: string;
};

export function decodeMemberChangedEvent(input: unknown): MemberChangedEvent {
  const value = publicationData(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation event");
  const type = Reflect.get(value, "type");
  const conversationId = Reflect.get(value, "conversationId");
  const workspaceId = Reflect.get(value, "workspaceId");
  if (
    type !== "member.changed.v1" ||
    typeof conversationId !== "string" ||
    !conversationId ||
    (workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId))
  )
    throw new Error("invalid conversation event");
  return { type, conversationId, ...(workspaceId ? { workspaceId } : {}) };
}

/**
 * Where one person's Activity stands after a write of theirs that can clear it (a Done, a read-all,
 * a mention read or unread, a conversation marked unread or read): whether anything is still unread,
 * and where their own channel's stream stood before that was read. A message published past
 * `streamPosition` may be missing from `hasUnread`.
 */
export type ActivityAttention = z.infer<typeof activityAttention>;

const activityAttention = z.object({
  hasUnread: z.boolean(),
  streamPosition: streamPositionSchema.optional(),
});

/**
 * Something reached one person's Activity inbox that no badge signal announces: a mention from
 * outside the channel they were notified of, or a Task assignment receipt naming them (a notice,
 * which counts no badge), or a write of theirs that can clear it, which carries its `attention`.
 * Published on that person's own channel; their nav dot takes `attention` as it stands, and
 * otherwise re-reads, as their Activity page always does.
 */
export type ActivityChangedEvent = {
  type: "activity.changed.v1";
  workspaceId: string;
  attention?: ActivityAttention;
};

const activityChangedEvent = z.object({
  type: z.literal("activity.changed.v1"),
  workspaceId: z.string().min(1),
  attention: activityAttention.optional(),
});

export function decodeActivityChangedEvent(input: unknown): ActivityChangedEvent {
  const event = activityChangedEvent.safeParse(publicationData(input));
  if (!event.success) throw new Error("invalid conversation event");
  return event.data;
}

const channelInfo = z.object({
  name: z.string().min(1),
  description: z.string(),
  archived: z.boolean(),
});

/**
 * A channel's name, description and archived state, as every member may see them. A channel
 * event carries it, as Slack's `channel_created` and `channel_rename` carry the channel, so a
 * sidebar updates its row from the event instead of re-reading its list.
 */
export type ChannelInfo = z.infer<typeof channelInfo>;

const channelUpdatedEvent = z.object({
  type: z.literal("channel.updated.v1"),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  /** The channel's info after the change. */
  channel: channelInfo.optional(),
  /** The channel was deleted, or hidden from the whole Workspace (`#general`). */
  gone: z.literal(true).optional(),
});

/**
 * A channel's own facts changed: its name, description or archived state, or it is gone. Published
 * on the Workspace channel, so every member's sidebar applies it (a private channel's on its
 * members' own channels instead), and on the channel's own conversation channel, so a page showing it refetches its header and composer state. An event
 * with neither `channel` nor `gone` (from an older server) has the sidebar re-read its lists.
 */
export type ChannelUpdatedEvent = z.infer<typeof channelUpdatedEvent>;

export function decodeChannelUpdatedEvent(value: unknown): ChannelUpdatedEvent {
  const event = decodeJsonPublication(channelUpdatedEvent, value);
  if (!event) throw new Error("invalid conversation event");
  return event;
}

/**
 * Something about the viewer's own place in a channel or DM changed, wherever they changed it (this tab,
 * another tab, another device) or whoever changed it for them (added to or removed from a
 * channel). Published only on the viewer's own `chat:user:<user_id>` channel, the way Slack sends
 * `channel_marked`, `channel_joined`, `channel_left` and `pref_change` to every connection of one
 * user. Like the other signals it names ids only, except that `channel.marked.v1` carries the
 * channel's unread count and read cursor after the move (Slack's `channel_marked` carries the
 * cursor as its `ts`), so a read in the open channel updates the sidebar without a list re-read per
 * message, and a page's stored window of that channel opens with the divider where it now is.
 *
 * - `channel.marked.v1`: the read cursor moved (read, marked unread, marked Done).
 * - `channel.joined.v1` / `channel.left.v1`: the viewer joined, was added, created, left or was removed.
 * - `channel.closed.v1` / `channel.opened.v1`: the viewer closed the chat in their list, or brought it back.
 * - `pref.changed.v1`: the viewer's `muted` state of a channel, their `pins` (pin, unpin, order), or
 *   their `sections` (one made, changed or removed, the sections' order, a chat moved into one).
 * - `dm.marked.v1`, `dm.opened.v1`, `dm.closed.v1`: the same for one of the viewer's DMs (Slack's
 *   `im_marked`, `im_open`, `im_close`); `dm.created.v1`: a DM with them was started (`im_created`).
 * - `saved.added.v1` / `saved.removed.v1`: the viewer saved or unsaved a message (Slack's
 *   `star_added` / `star_removed`).
 */
const viewerEventIds = { workspaceId: z.string().min(1), conversationId: z.string().min(1) };
const viewerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["channel.marked.v1", "dm.marked.v1"]),
    ...viewerEventIds,
    unreadCount: z.number().int().nonnegative(),
    // Where the read cursor stands after the move, as Slack's `channel_marked` carries its `ts`.
    readThroughSequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.enum([
      "channel.joined.v1",
      "channel.left.v1",
      "channel.closed.v1",
      "channel.opened.v1",
      "dm.created.v1",
      "dm.opened.v1",
      "dm.closed.v1",
    ]),
    ...viewerEventIds,
  }),
  z.object({
    type: z.enum(["saved.added.v1", "saved.removed.v1"]),
    ...viewerEventIds,
    messageId: z.string().min(1),
  }),
  z.object({
    type: z.literal("pref.changed.v1"),
    workspaceId: z.string().min(1),
    name: z.enum(["muted", "pins", "sections"]),
  }),
]);

export type ViewerEvent = z.infer<typeof viewerEvent>;

/** A publication's JSON (raw bytes or already parsed) read as `schema`, or undefined when it is
 * some other publication on the channel. */
function decodeJsonPublication<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const data = publicationDataOrUndefined(value);
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/** The event, or undefined for any other publication on the viewer's channel (most are messages). */
export function decodeViewerEvent(value: unknown): ViewerEvent | undefined {
  return decodeJsonPublication(viewerEvent, value);
}

const channelCreatedEvent = z.object({
  type: z.literal("channel.created.v1"),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  /** Absent only from an older server, which has the sidebar re-read its lists. */
  channel: channelInfo.optional(),
});

/**
 * A channel was created in the Workspace, by a person, an Agent or an action card (Slack's
 * `channel_created`). Published on the Workspace channel with the channel's info, so every
 * member's sidebar lists it from the event alone; a private channel's goes to its members' own
 * channels instead.
 */
export type ChannelCreatedEvent = z.infer<typeof channelCreatedEvent>;

/** The event, or undefined for any other publication on the Workspace channel. */
export function decodeChannelCreatedEvent(value: unknown): ChannelCreatedEvent | undefined {
  return decodeJsonPublication(channelCreatedEvent, value);
}

const messageReactionEvent = z.object({
  type: z.literal("message.reaction.v1"),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  threadRootId: z.string().min(1).optional(),
  /** The message's `reactionVersion` once the write committed. */
  version: z.number().int().positive(),
  /** The message's reactions after the write; null once none is left. */
  reactions: z
    .array(
      z.object({
        emoji: z.string().min(1),
        count: z.number().int().positive(),
        reactors: z.array(z.object({ id: z.string().min(1), label: z.string() })),
      }),
    )
    .nullable(),
});

/**
 * A message's reactions changed (Slack's `reaction_added` / `reaction_removed`): the whole summary
 * and version after a committed write (`reaction-sync.ts`). Only on the conversation's own channel,
 * whose subscribers may read those reactions anyway; unlike the id-only signals it names reactors.
 */
export type MessageReactionEvent = z.infer<typeof messageReactionEvent>;

/** The event, or undefined for any other publication on the conversation's channel. */
export function decodeMessageReactionEvent(value: unknown): MessageReactionEvent | undefined {
  return decodeJsonPublication(messageReactionEvent, value);
}
