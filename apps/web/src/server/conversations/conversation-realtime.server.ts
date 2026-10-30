import {
  conversationRealtimeChannel,
  userConversationChannel,
  workspaceConversationChannel,
  type ActivityChangedEvent,
  type ChannelCreatedEvent,
  type ChannelUpdatedEvent,
  type MessageAvailableEvent,
  type MessageReactionEvent,
  type MemberChangedEvent,
  type ViewerEvent,
  type ChannelInfo,
} from "#src/features/conversations/conversation-realtime";
import { type ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import type { TaskChangedEvent } from "#src/features/tasks/task-realtime";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { ChannelAudience, MessageSignalScope } from "./conversation-signal-scope.server";
import {
  publishConversationReadChanged,
  type ConversationReadChangedInput,
} from "./conversation-read-realtime.server";

export type ConversationRealtimeMessage = {
  conversationId: string;
  messageId: string;
  sequence: number;
  /** The message's Workspace; scopes the workspace-level signal fan-out. */
  workspaceId?: string;
  /** Present only for a thread reply (channel unread never counts thread replies). */
  threadRootId?: string;
  /** The viewing user of a direct message; routes the event to that user's own signal channel. */
  userId?: string;
  /** Present only for a direct message with an Agent: that Agent. */
  agentId?: string;
  /** Present only for a direct conversation between people: its members, each of whom gets the
   * event on their own signal channel, naming the other (`MessageAvailableEvent.peerUserId`). */
  directUserIds?: readonly string[];
  /** With `directUserIds`: the two people its key names, so a member's peer stays the other
   * even after the other's member row is gone. */
  directPair?: readonly [string, string];
  /** Present only for a person's send: its idempotency key, so the sender's page can match the
   * pending copy it shows to this message (see `MessageAvailableEvent.idempotencyKey`). */
  idempotencyKey?: string;
  /** The person who wrote the message (`MessageAvailableEvent.senderUserId`); absent for an
   * Agent's or a system message. */
  senderUserId?: string;
};

/** A Task write's announcement (`TaskChangedEvent`) with where it goes, from
 * `conversationSignalScopes`: a User–Agent direct message's to its human viewer (`userId` and
 * `agentId`), one between people's to each member (`directUserIds`), a private channel's to each
 * of its people (`memberUserIds`), a public channel's to the Workspace. `publicationId` makes a
 * retried write's announcement a duplicate. */
export type TaskChangedSignal = Omit<TaskChangedEvent, "type" | "privateChannel"> &
  Pick<
    MessageSignalScope,
    "userId" | "agentId" | "directUserIds" | "directPair" | "memberUserIds"
  > & {
    publicationId: string;
  };

/** A channel's change as announced: its info after the change, or that it was deleted or hidden
 * from the whole Workspace. */
export type ChannelUpdatedSignal = {
  workspaceId: string;
  conversationId: string;
} & ChannelAudience &
  ({ channel: ChannelInfo; gone?: undefined } | { gone: true; channel?: undefined });

export type ChannelCreatedSignal = {
  workspaceId: string;
  conversationId: string;
  channel: ChannelInfo;
} & ChannelAudience;

/** A channel row's info as every member sees it: `PublicChannels.names` and the channel events
 * both build it here, so an event never disagrees with a read. */
export function channelInfoOf(channel: {
  channelName: string | null;
  description: string;
  archivedAt: Date | null;
}): ChannelInfo {
  return {
    name: channel.channelName!,
    description: channel.description.trim(),
    archived: channel.archivedAt !== null,
  };
}

export type RevokedConversations = {
  conversationIds: readonly string[];
  userIds: readonly string[];
};

export type ReactionSignal = Omit<MessageReactionEvent, "type">;

export type ConversationRealtime = {
  messageAvailable(input: ConversationRealtimeMessage & { publicationId?: string }): Promise<void>;
  /** One message's row data and unread effect, to each named person's own channel
   * (`ConversationActivityEvent`). Optional: a port without it announces none, and a page falls
   * back to its own reconciliation. */
  conversationActivity?(input: {
    userIds: readonly string[];
    event: ConversationActivityEvent;
  }): Promise<void>;
  /** A push telling each named channel's open pages that its member list is stale. */
  memberChanged(input: { workspaceId: string; conversationIds: readonly string[] }): Promise<void>;
  /** A push telling the Workspace's sidebars and the channel's open pages that its name,
   * description or archived state changed, or that it is gone. Optional: a port without it
   * announces nothing. */
  channelUpdated?(input: ChannelUpdatedSignal): Promise<void>;
  /** A push telling the Workspace's sidebars that a channel was created, with its info. Optional:
   * a port without it announces nothing. */
  channelCreated?(input: ChannelCreatedSignal): Promise<void>;
  /** Ends these people's subscriptions to conversations they no longer read (they left a private
   * channel, or the Workspace), now rather than at their next token refresh. Optional: a port
   * without it ends none. */
  revokeConversations?(input: RevokedConversations): Promise<void>;
  /** A push telling open Tasks pages the new copies of the Tasks a write changed. Optional: a
   * port without it announces nothing. */
  taskChanged?(input: TaskChangedSignal): Promise<void>;
  /** A push telling one person's Activity inbox that it changed where no badge signal says so
   * (`ActivityChangedEvent`). Optional: a port without it announces nothing. */
  activityChanged?(input: { workspaceId: string; userId: string }): Promise<void>;
  /** A push telling each named person's own pages that their place in a conversation changed
   * (`ViewerEvent`). Optional: a port without it announces nothing. */
  viewerChanged?(input: { userIds: readonly string[]; event: ViewerEvent }): Promise<void>;
  /** `MessageReactionEvent`; optional, like the above. */
  reactionChanged?(input: ReactionSignal): Promise<void>;
  /** A member's monotone conversation read position, scoped to one conversation. */
  conversationReadChanged?(input: ConversationReadChangedInput): Promise<void>;
};

/** Where a channel's sidebar signal goes: a private channel's people's own channels, or the
 * Workspace's. */
function sidebarChannels(workspaceId: string, memberUserIds: readonly string[] | undefined) {
  return memberUserIds
    ? memberUserIds.map(userConversationChannel)
    : [workspaceConversationChannel(workspaceId)];
}

export class CentrifugoConversationRealtime implements ConversationRealtime {
  constructor(private readonly centrifugo: CentrifugoServerApi) {}

  async revokeConversations(input: RevokedConversations) {
    await this.centrifugo.unsubscribe(
      input.conversationIds.flatMap((conversationId) =>
        input.userIds.map((user) => ({
          user,
          channel: conversationRealtimeChannel(conversationId),
        })),
      ),
    );
  }

  async memberChanged(input: { workspaceId: string; conversationIds: readonly string[] }) {
    // One publication per channel: each event names its own conversation, which the page checks.
    await Promise.all(
      input.conversationIds.map((conversationId) => {
        const event: MemberChangedEvent = {
          type: "member.changed.v1",
          conversationId,
          workspaceId: input.workspaceId,
        };
        return this.centrifugo.publishJson(
          conversationRealtimeChannel(conversationId),
          event,
          crypto.randomUUID(),
        );
      }),
    );
  }

  async channelUpdated({ memberUserIds, ...input }: ChannelUpdatedSignal) {
    const event: ChannelUpdatedEvent = { type: "channel.updated.v1", ...input };
    await this.centrifugo.broadcast(
      [
        ...sidebarChannels(input.workspaceId, memberUserIds),
        conversationRealtimeChannel(input.conversationId),
      ],
      event,
      crypto.randomUUID(),
    );
  }

  async channelCreated({ memberUserIds, ...input }: ChannelCreatedSignal) {
    const event: ChannelCreatedEvent = { type: "channel.created.v1", ...input };
    await this.centrifugo.broadcast(
      sidebarChannels(input.workspaceId, memberUserIds),
      event,
      crypto.randomUUID(),
    );
  }

  async activityChanged(input: { workspaceId: string; userId: string }) {
    const event: ActivityChangedEvent = {
      type: "activity.changed.v1",
      workspaceId: input.workspaceId,
    };
    await this.centrifugo.publishJson(userConversationChannel(input.userId), event);
  }

  async viewerChanged(input: { userIds: readonly string[]; event: ViewerEvent }) {
    await this.centrifugo.broadcast(
      input.userIds.map(userConversationChannel),
      input.event,
      crypto.randomUUID(),
    );
  }

  async reactionChanged(input: ReactionSignal) {
    // Only its own channel; a fresh key, as Centrifugo drops a key it saw minutes ago.
    await this.centrifugo.publishJson(
      conversationRealtimeChannel(input.conversationId),
      { type: "message.reaction.v1", ...input } satisfies MessageReactionEvent,
      `${input.messageId}:reaction:${crypto.randomUUID()}`,
    );
  }

  async conversationReadChanged(input: ConversationReadChangedInput) {
    await publishConversationReadChanged(this.centrifugo, input);
  }

  async taskChanged(signal: TaskChangedSignal) {
    const { publicationId, userId, agentId, directUserIds, memberUserIds, ...announced } = signal;
    const event: TaskChangedEvent = {
      type: "task.changed.v1",
      workspaceId: announced.workspaceId,
      conversationId: announced.conversationId,
      tasks: announced.tasks,
      deleted: announced.deleted,
      ...(memberUserIds ? { privateChannel: true as const } : {}),
    };
    const people = directUserIds ?? memberUserIds;
    if (people) {
      await this.centrifugo.broadcast(people.map(userConversationChannel), event, publicationId);
      return;
    }
    await this.centrifugo.publishJson(
      userId && agentId
        ? userConversationChannel(userId)
        : workspaceConversationChannel(announced.workspaceId),
      event,
      publicationId,
    );
  }

  /**
   * One new message, to its conversation's own channel only: that is what the open page needs to
   * reconcile, and only people who may read the conversation can subscribe to it. Everything the
   * sidebar and the Activity dot need travels as `conversation.activity.v1` to each recipient's
   * own channel (`announceMessage`, `conversation-activity.server.ts`), so a channel's message
   * never reaches a tab that is not in it and no tab re-reads a list to learn about one message.
   */
  async messageAvailable(input: ConversationRealtimeMessage & { publicationId?: string }) {
    const { publicationId, directUserIds, directPair, ...message } = input;
    void directUserIds;
    void directPair;
    const event: MessageAvailableEvent = {
      type: "message.available.v1",
      ...message,
    };
    await this.centrifugo.publishJson(
      conversationRealtimeChannel(input.conversationId),
      event,
      publicationId ?? input.messageId,
    );
  }

  async conversationActivity(input: {
    userIds: readonly string[];
    event: ConversationActivityEvent;
  }) {
    // One request for every recipient's own channel; a fresh key, as Centrifugo drops a key it
    // saw minutes ago.
    await this.centrifugo.broadcast(
      input.userIds.map(userConversationChannel),
      input.event,
      crypto.randomUUID(),
    );
  }
}

/**
 * Runs one best-effort announcement once a write has committed: without an injected port it uses
 * the production Centrifugo one, so no write path can skip its signal by leaving it unwired, and a
 * failed publish is logged as `conversation_realtime:<name>_failed` instead of failing the write.
 */
async function announceBestEffort<Port>(
  realtime: Port | undefined,
  publish: (port: Port | CentrifugoConversationRealtime) => Promise<void> | undefined,
  log: { name: string; workspace_id: string } & Record<string, string | number>,
): Promise<void> {
  try {
    await publish(realtime ?? new CentrifugoConversationRealtime(createCentrifugoServerApi()));
  } catch (error) {
    const { name, ...fields } = log;
    console.warn(
      JSON.stringify({
        event: `conversation_realtime:${name}_failed`,
        ...fields,
        error_type: errorType(error),
      }),
    );
  }
}

/**
 * Tells the open pages of these channels that their member list changed — the composer's @-list
 * and plain-@handle labels — once the membership write has committed. Every write that changes
 * who is in a channel calls this, the way Slack sends `member_joined_channel` and Discord sends
 * `GUILD_MEMBER_ADD`, so a page never polls or waits for a refresh.
 *
 * Best effort: the write already happened, and a page that misses the signal refetches whenever
 * it (re)subscribes without replaying what it missed, or regains focus. That client's own
 * deadline bounds how long the write waits.
 */
export async function announceMemberChanged(
  realtime: Pick<ConversationRealtime, "memberChanged"> | undefined,
  input: { workspaceId: string; conversationIds: readonly string[] },
): Promise<void> {
  if (input.conversationIds.length === 0) return;
  await announceBestEffort(realtime, (port) => port.memberChanged(input), {
    name: "member_changed",
    workspace_id: input.workspaceId,
    conversation_count: input.conversationIds.length,
  });
}

/**
 * A channel's membership changed for these people: its open pages hear their member list is stale
 * (`announceMemberChanged`), and each person who joined or left hears it on their own channel
 * (`channel.joined.v1` / `channel.left.v1`), as Slack sends both `member_joined_channel` and
 * `channel_joined`. An Agent-only change names nobody.
 */
export async function announceJoinedOrLeft(
  realtime:
    | Pick<ConversationRealtime, "memberChanged" | "viewerChanged" | "revokeConversations">
    | undefined,
  input: {
    workspaceId: string;
    conversationId: string;
    change: "joined" | "left";
    userIds: readonly string[];
    /** Whether the channel is private, so those who left no longer read it and their open
     * pages' subscriptions to it end (`announceConversationsRevoked`). */
    private?: boolean;
  },
): Promise<void> {
  const { workspaceId, conversationId, userIds } = input;
  await Promise.all([
    announceMemberChanged(realtime, { workspaceId, conversationIds: [conversationId] }),
    announceViewerEvent(realtime, {
      userIds,
      event: { type: `channel.${input.change}.v1`, workspaceId, conversationId },
    }),
    input.change === "left" && input.private
      ? announceConversationsRevoked(realtime, {
          workspaceId,
          userIds,
          conversationIds: [conversationId],
        })
      : undefined,
  ]);
}

/** Ends these people's subscriptions to conversations they no longer read (`revokeConversations`),
 * once the write has committed. Best effort like `announceMemberChanged`: a subscription it misses
 * ends when its token next renews, which the read rule refuses. */
export async function announceConversationsRevoked(
  realtime: Pick<ConversationRealtime, "revokeConversations"> | undefined,
  input: { workspaceId: string } & RevokedConversations,
): Promise<void> {
  const { workspaceId, ...revoked } = input;
  if (revoked.userIds.length === 0 || revoked.conversationIds.length === 0) return;
  await announceBestEffort(realtime, (port) => port.revokeConversations?.(revoked), {
    name: "conversation_revoked",
    workspace_id: workspaceId,
  });
}

/**
 * Tells every open sidebar of the Workspace, and the channel's open pages, that the channel was
 * renamed, described, archived, unarchived or deleted, once the write has committed — the way Slack sends
 * `channel_rename`/`channel_archive` to every connection of a workspace and Discord sends
 * `CHANNEL_UPDATE`, with the channel's info after the change (or `gone`), so a sidebar updates its
 * row without a read. Best effort like `announceMemberChanged`: a page that misses it catches up
 * on its next load or focus.
 */
export async function announceChannelUpdated(
  realtime: Pick<ConversationRealtime, "channelUpdated"> | undefined,
  input: ChannelUpdatedSignal,
): Promise<void> {
  await announceBestEffort(realtime, (port) => port.channelUpdated?.(input), {
    name: "channel_updated",
    workspace_id: input.workspaceId,
  });
}

/** A message's reactions after a committed write; best effort, as above. */
export async function announceReactionChanged(
  realtime: Pick<ConversationRealtime, "reactionChanged"> | undefined,
  workspaceId: string,
  signal: ReactionSignal,
): Promise<void> {
  await announceBestEffort(realtime, (port) => port.reactionChanged?.(signal), {
    name: "reaction_changed",
    workspace_id: workspaceId,
  });
}

/**
 * Tells every open sidebar of the Workspace that a channel was created, once the write has
 * committed, the way Slack sends `channel_created` to every connection of a workspace. Best effort
 * like `announceChannelUpdated`: a sidebar that misses it lists the channel on its next read.
 */
export async function announceChannelCreated(
  realtime: Pick<ConversationRealtime, "channelCreated"> | undefined,
  input: ChannelCreatedSignal,
): Promise<void> {
  await announceBestEffort(realtime, (port) => port.channelCreated?.(input), {
    name: "channel_created",
    workspace_id: input.workspaceId,
  });
}

/**
 * Tells each named person's open pages, on their own channel only, that their place in a
 * conversation or their Saved list changed (`ViewerEvent`): a read, a join or leave, a close, a
 * mute or pin, a save, the way Slack sends `channel_marked`, `channel_joined`, `pref_change` or
 * `star_added` to every connection of that user. Sent once the write has committed. Best effort like `announceMemberChanged`: a page that
 * misses it catches up on its next list read.
 */
export async function announceViewerEvent(
  realtime: Pick<ConversationRealtime, "viewerChanged"> | undefined,
  input: { userIds: readonly string[]; event: ViewerEvent },
): Promise<void> {
  if (input.userIds.length === 0) return;
  await announceBestEffort(realtime, (port) => port.viewerChanged?.(input), {
    name: "viewer_changed",
    workspace_id: input.event.workspaceId,
    viewer_event: input.event.type,
  });
}

/**
 * Tells the Workspace's open Tasks pages that a deleted channel's Tasks are gone
 * (`task.changed.v1` with only `deleted`), once the delete has committed. Best effort like
 * `announceChannelUpdated`: a page that misses it drops them on its next read.
 */
export async function announceChannelTasksDeleted(
  realtime: Pick<ConversationRealtime, "taskChanged"> | undefined,
  input: { workspaceId: string; conversationId: string; deleted: string[] } & ChannelAudience,
): Promise<void> {
  if (input.deleted.length === 0) return;
  await announceBestEffort(
    realtime,
    (port) =>
      port.taskChanged?.({
        ...input,
        tasks: [],
        publicationId: `${input.conversationId}:channel-deleted`,
      }),
    { name: "channel_tasks_deleted", workspace_id: input.workspaceId },
  );
}
