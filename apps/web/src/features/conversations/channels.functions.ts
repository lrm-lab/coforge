import { createServerFn } from "@tanstack/react-start";
import { channelInput, channelScope } from "./channel-function-scope.server";
import { z } from "zod";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { toggleChannelReaction } from "#src/server/conversations/reaction-toggles.server";
import { attachViewerViews } from "#src/server/conversations/viewer-views.server";
import { attachmentView } from "#src/server/attachments/attachment-view.server";
import {
  attachmentIdsSchema,
  conversationPageInputSchema,
  conversationUpdatesCursorSchema,
  mentionSelectorsSchema,
} from "./conversation.schemas";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import {
  readAfterStreamPositions,
  readWindowAfterStreamPosition,
} from "#src/server/conversations/chat-stream-positions.server";
import {
  conversationRealtimeChannel,
  userConversationChannel,
  workspaceConversationChannel,
} from "./conversation-realtime";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { sentAsTaskHook } from "#src/server/tasks/sent-as-task.server";
import { announceSentTask } from "#src/server/tasks/browser-task-board.server";
import { bestEffortMessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { browserMessageMention } from "#src/server/conversations/mentions.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

const channelPageInput = channelInput.extend(conversationPageInputSchema);
const channelUpdatesInput = channelInput.extend(conversationUpdatesCursorSchema.shape);

export const listPublicChannels = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    // Both signal channels keep the list live (messages on the Workspace's, the viewer's own
    // read and membership changes on theirs); their positions are read first.
    const { streamPositions, data } = await readAfterStreamPositions(
      [workspaceConversationChannel(workspaceId), userConversationChannel(userId)],
      () => channels.list(workspaceId, userId),
    );
    return { streamPositions, channels: data };
  });

/** Every channel's id and current name, closed ones included: what a body's channel references
 * link by, read with the stream positions of the channels that keep it live with
 * `channel.created.v1` and `channel.updated.v1`: the Workspace's for public channels, the
 * viewer's own for their private ones. */
export const listChannelNames = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    const { streamPositions, data } = await readAfterStreamPositions(
      [workspaceConversationChannel(workspaceId), userConversationChannel(userId)],
      () => channels.names(workspaceId, userId),
    );
    return { streamPositions, names: data };
  });

/** Creates a channel, then adds the people and Agents picked for it (`PublicChannels.createWithMembers`).
 * `membersAddFailed` says the channel exists but the picked members were not added. */
export const createPublicChannel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      name: z.string().trim().regex(CHANNEL_NAME_PATTERN),
      projectId: z.uuid().optional(),
      userIds: z.array(z.uuid()).max(100).default([]),
      agentIds: z.array(z.uuid()).max(100).default([]),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.createWithMembers(workspaceId, userId, data);
  });

export const loadPublicChannel = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelPageInput)
  .handler(async ({ data, context }) => {
    const { channels, db, workspaceId, userId } = channelScope(context);
    const page = await readWindowAfterStreamPosition(
      data,
      conversationRealtimeChannel(data.channelId),
      () =>
        channels.open(workspaceId, userId, data.channelId, {
          beforeSequence: data.beforeSequence,
          afterSequence: data.afterSequence,
          limit: data.limit,
        }),
    );
    return {
      ...page,
      messages: await attachViewerViews(db, workspaceId, userId, page.messages),
    };
  });

/** The composer's @-completion group of the Workspace's people and public Agents outside a
 * channel. */
export const loadPublicChannelMentionOutsiders = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.mentionOutsiders(workspaceId, userId, data.channelId);
  });

export const loadPublicChannelMentionables = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.mentionDirectory(workspaceId, userId, data.channelId);
  });

export const loadPublicChannelUpdates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelUpdatesInput)
  .handler(async ({ data, context }) => {
    const { channels, db, workspaceId, userId } = channelScope(context);
    const messages = await channels.updates(
      workspaceId,
      userId,
      data.channelId,
      data.afterSequence,
      data.afterReplySequence,
    );
    return attachViewerViews(db, workspaceId, userId, messages);
  });

export const loadPublicChannelMembers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.members(workspaceId, { userId }, data.channelId);
  });

export const addPublicChannelMembers = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      userIds: z.array(z.uuid()).default([]),
      agentIds: z.array(z.uuid()).default([]),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.addMembers(workspaceId, { userId }, data.channelId, {
      userIds: data.userIds,
      agentIds: data.agentIds,
    });
  });

/** The sender acts on mentions of their own messages that did not reach someone outside the
 * channel: `add` makes each target a channel member. */
export const executeMentionActions = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      action: z.enum(["notify", "add"]),
      resolutionIds: z.array(z.uuid()).min(1).max(20),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.executeMentionActions(workspaceId, userId, data.action, data.resolutionIds);
  });

/** Promote/demote a channel member's stored `channelRole`. Human-only: there is no
 * Agent CLI/API route for this. `PublicChannels.setChannelRole` enforces `manage_roles`
 * (Workspace owner/admin, or channel admin of this channel) and rejects `#general`. */
export const setPublicChannelMemberRole = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput
      .extend({
        userId: z.uuid().optional(),
        agentId: z.uuid().optional(),
        role: z.enum(["admin", "member"]),
      })
      .refine((data) => (data.userId === undefined) !== (data.agentId === undefined), {
        message: "exactly one of userId or agentId is required",
      }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    const member = data.userId ? { userId: data.userId } : { agentId: data.agentId! };
    return channels.setChannelRole(workspaceId, userId, data.channelId, member, data.role);
  });

export const joinPublicChannel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.join(workspaceId, userId, data.channelId);
  });

/** Marks every top-level message through `throughSequence` read for the sidebar badge. */
export const markPublicChannelRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ throughSequence: z.number().int().positive() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.markRead(workspaceId, userId, data.channelId, data.throughSequence);
  });

export const leavePublicChannel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.leave(workspaceId, userId, data.channelId);
  });

export const removePublicChannelMember = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      userId: z.uuid().optional(),
      agentId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    if ((data.userId === undefined) === (data.agentId === undefined))
      throw new AppError("INVALID_INPUT");
    return channels.removeMember(
      workspaceId,
      userId,
      data.channelId,
      data.userId ? { userId: data.userId } : { agentId: data.agentId! },
    );
  });

/** The settings panel's Info form: renames the channel and/or changes its description. */
export const updatePublicChannelInfo = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      name: z.string().trim().optional(),
      description: z.string().trim().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.updateInfo(workspaceId, { userId }, data.channelId, {
      name: data.name,
      description: data.description,
    });
  });

export const setPublicChannelCoordinator = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ coordinatorAgentId: z.uuid().nullable() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setCoordinator(workspaceId, userId, data.channelId, data.coordinatorAgentId);
  });

export const sendPublicChannelMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      idempotencyKey: z.uuid(),
      body: z.string().trim().min(1).max(8_000),
      attachmentIds: attachmentIdsSchema,
      threadRootId: z.uuid().optional(),
      mentions: mentionSelectorsSchema,
      /** "As task": the message is a Task from the moment it exists (top-level only). */
      asTask: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { db, workspaceId, userId, username } = channelScope(context);
    const { asTask, ...input } = data;
    const centrifugo = createCentrifugoServerApi();
    const channels = new PublicChannels(
      db,
      undefined,
      centrifugo,
      bestEffortMessageNotifier(db),
      new CentrifugoConversationRealtime(centrifugo),
    );
    const message = await channels.send({
      ...input,
      workspaceId,
      userId,
      withinSend: asTask ? await sentAsTaskHook(db, workspaceId) : undefined,
    });
    if (asTask)
      await announceSentTask(db, { conversationId: data.channelId, workspaceId }, message.id);
    return {
      id: message.id,
      sequence: message.sequence,
      threadRootId: message.threadRootId ?? undefined,
      senderMemberId: message.senderMemberId,
      senderKind: "user" as const,
      // The echo must read exactly like the same message after a reload: a display name, with
      // the handle carried separately (see `sender-display.server.ts`).
      senderName: humanLabel({ displayName: message.sender?.user?.displayName }),
      senderHandle: username,
      // A human-sent echo never carries an Agent id, and a human sender is never deleted.
      senderAgentId: undefined,
      senderUserId: userId,
      senderDeleted: false,
      senderAvatarUrl: workspaceUserAvatarUrl(
        workspaceId,
        userId,
        message.sender?.user?.avatarObjectKey ?? null,
      ),
      body: message.body,
      // An ISO string, like the stream it joins (`mapBrowserMessage`).
      createdAt: message.createdAt.toISOString(),
      mentions: message.mentions.map(browserMessageMention),
      attachments: message.attachments.map((attachment) => attachmentView(attachment)),
      reactions: undefined,
      // A human-sent message never carries an action card (those are Agent-authored only).
      actionCard: undefined,
      unresolvedMentionHandles: message.unresolvedMentionHandles,
      pendingMentionActions: message.pendingMentionActions,
    };
  });

/** The viewer's own emoji reaction on a channel message; returns the message's fresh summaries. */
export const toggleChannelMessageReaction = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      messageId: z.uuid(),
      emoji: z.string().min(1).max(16),
      active: z.boolean(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { reactions } = await toggleChannelReaction(context, data);
    return reactions ?? undefined;
  });

export const setPublicChannelCollapseLongMessages = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ collapseLongMessages: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setCollapseLongMessages(
      workspaceId,
      userId,
      data.channelId,
      data.collapseLongMessages,
    );
  });

export const setPublicChannelMuted = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ muted: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setUserMuted(workspaceId, userId, data.channelId, data.muted);
  });

/** Pins the conversation after this member's other pins, or unpins it (#121). */
export const setPublicConversationPinned = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ pinned: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setUserPinned(workspaceId, userId, data.channelId, data.pinned);
  });
