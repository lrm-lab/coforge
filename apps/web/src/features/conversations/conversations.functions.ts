import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { threadUnreadBatchInput } from "./thread-unread-inputs";
import {
  markVersionedThreadRead,
  readThreadUnreadVersion,
  threadUnreadRealtime,
} from "#src/server/conversations/thread-unread-marks.server";
import { humanLabel } from "#src/lib/human-label";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  conversationAroundInputSchema,
  conversationOpenInputSchema,
  conversationThreadInputSchema,
  directConversationInputSchema,
  directConversationPageInputSchema,
  directConversationUpdatesInputSchema,
  readConversationThreadInputSchema,
  sendConversationMessageInputSchema,
  toggleMessageReactionInputSchema,
} from "./conversation.schemas";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { TaskConversationPages } from "#src/server/conversations/task-conversation-page.server";
import { sentAsTaskHook } from "#src/server/tasks/sent-as-task.server";
import { announceSentTask } from "#src/server/tasks/browser-task-board.server";
import {
  readAfterStreamPositions,
  readWindowAfterStreamPosition,
} from "#src/server/conversations/chat-stream-positions.server";
import { conversationRealtimeChannel } from "./conversation-realtime";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { toggleDirectReaction } from "#src/server/conversations/reaction-toggles.server";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { firstUnreadOnOpen } from "#src/server/conversations/conversation-open.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { withMessageSendTrace } from "#src/server/observability/tracing.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

export const openDirectConversation = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.union([z.object({ agentId: z.uuid() }), z.object({ userId: z.uuid() })]))
  .handler(({ data, context }) =>
    new DirectConversations(context.db).open(context.workspaceId, context.user.id, data),
  );

export const loadDirectConversation = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationPageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return readWindowAfterStreamPosition(
      data,
      conversationRealtimeChannel(data.conversationId),
      () =>
        new DirectConversations(db).page(workspaceId, user.id, data.conversationId, {
          beforeSequence: data.beforeSequence,
          afterSequence: data.afterSequence,
          limit: data.limit,
          includeViewerViews: true,
        }),
    );
  });

export const loadDirectConversationUpdates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationUpdatesInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new DirectConversations(db).updates(
      workspaceId,
      user.id,
      data.conversationId,
      data.afterSequence,
      data.afterReplySequence,
      { includeViewerViews: true },
    );
  });

export const loadConversationAround = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(conversationAroundInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const { streamPositions, data: page } = await readAfterStreamPositions(
      [conversationRealtimeChannel(data.conversationId)],
      () =>
        new ConversationHistory(db).loadAround(
          workspaceId,
          user.id,
          data.conversationId,
          data.messageId,
          undefined,
          { includeViewerViews: true },
        ),
    );
    return {
      viewerId: user.id,
      ...page,
      streamPositions,
    };
  });

export const loadConversationOpen = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(conversationOpenInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const scope = { workspaceId, userId: user.id, conversationId: data.conversationId };
    const [firstUnread, markedUnreadVersion] = await Promise.all([
      firstUnreadOnOpen(db, { ...scope, threadRootId: data.threadRootId }),
      data.threadRootId ? readThreadUnreadVersion(db, scope, data.threadRootId) : undefined,
    ]);
    return { firstUnread, ...(markedUnreadVersion && { markedUnreadVersion }) };
  });

export const loadConversationThread = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(conversationThreadInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    return new ConversationHistory(db).loadThread(
      workspaceId,
      user.id,
      data.conversationId,
      data.threadRootId,
      { includeViewerViews: true },
    );
  });

export const markDirectThreadRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(readConversationThreadInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    if (data.markedUnreadVersion)
      return markVersionedThreadRead(
        db,
        threadUnreadRealtime(),
        { workspaceId, userId: user.id, conversationId: data.conversationId },
        { rootMessageId: data.threadRootId, version: data.markedUnreadVersion },
        data.throughSequence,
      );
    await new DirectConversations(db).markThreadRead(
      workspaceId,
      user.id,
      data.conversationId,
      data.threadRootId,
      data.throughSequence,
    );
  });

/** Advances the DM read cursor for the sidebar badge; monotone and clamped. */
export const markDirectConversationRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ throughSequence: z.number().int().positive() }))
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    await new DirectConversations(db).markRead(
      workspaceId,
      user.id,
      data.conversationId,
      data.throughSequence,
    );
  });

/** Pins the viewer's DM after their other pins, or unpins it (#121). */
export const setDirectConversationPinned = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ pinned: z.boolean() }))
  .handler(({ context: { user, db, workspaceId }, data }) =>
    new DirectConversations(db).setPinned(workspaceId, user.id, data.conversationId, data.pinned),
  );

/** Mutes the viewer's DM for themself, or lets it be heard again. */
export const setDirectConversationMuted = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ muted: z.boolean() }))
  .handler(({ context: { user, db, workspaceId }, data }) =>
    new DirectConversations(db).setMuted(workspaceId, user.id, data.conversationId, data.muted),
  );

/** Folds long messages in the viewer's DM behind "Show more", or shows them in full. */
export const setDirectConversationCollapseLongMessages = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ collapseLongMessages: z.boolean() }))
  .handler(({ context: { user, db, workspaceId }, data }) =>
    new DirectConversations(db).setCollapseLongMessages(
      workspaceId,
      user.id,
      data.conversationId,
      data.collapseLongMessages,
    ),
  );

/** Marks the viewer's DM unread, or clears the marker (#122). */
export const setDirectConversationUnread = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ unread: z.boolean() }))
  .handler(({ context: { user, db, workspaceId }, data }) =>
    new DirectConversations(db).setUnread(workspaceId, user.id, data.conversationId, data.unread),
  );

export const markDirectConversationAllRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ batch: threadUnreadBatchInput.optional() }))
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const realtime = data.batch ? threadUnreadRealtime() : undefined;
    await new DirectConversations(db, realtime).markAllRead(
      workspaceId,
      user.id,
      data.conversationId,
      data.batch,
    );
  });

/** Closes the viewer's DM in their list only, or brings it back (#122). */
export const setDirectConversationHidden = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend({ hidden: z.boolean() }))
  .handler(({ context: { user, db, workspaceId }, data }) =>
    new DirectConversations(db).setHidden(workspaceId, user.id, data.conversationId, data.hidden),
  );

export const sendDirectConversationMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(sendConversationMessageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    await new DirectConversations(db).authorize(workspaceId, user.id, data.conversationId, {
      canSend: true,
    });
    await new WorkspaceAssistants(db).prepareConversation(
      workspaceId,
      user.id,
      data.conversationId,
      (input) => productionCloudComputers(db).ensureDefault(input),
    );
    return withMessageSendTrace(
      data.idempotencyKey,
      { "coforge.conversation_id": data.conversationId },
      async (sendTrace) => {
        const centrifugo = createCentrifugoServerApi();
        const withinSend = data.asTask ? sentAsTaskHook(data.taskPriority) : undefined;
        // The echo's sender profile does not depend on the send.
        const [message, profile] = await Promise.all([
          sendTrace.measure("message.persist_and_publish", () =>
            new DirectConversations(db).send(
              workspaceId,
              user.id,
              data.conversationId,
              {
                idempotencyKey: data.idempotencyKey,
                body: data.body,
                attachmentIds: data.attachmentIds,
                threadRootId: data.threadRootId,
                withinSend,
              },
              {
                idempotency: getMessageRequestIdempotency(),
                centrifugo,
                realtime: new CentrifugoConversationRealtime(centrifugo),
              },
            ),
          ),
          db.user.findUnique({
            where: { id: user.id },
            select: { displayName: true, avatarObjectKey: true },
          }),
        ]);
        if (data.asTask)
          await announceSentTask(
            db,
            { conversationId: data.conversationId, workspaceId },
            message.id,
          );
        return {
          id: message.id,
          sequence: message.sequence,
          threadRootId: data.threadRootId,
          senderKind: "user" as const,
          senderMemberId: message.senderMemberId,
          // Reads exactly like the same message after a reload: display name, handle separately.
          senderName: humanLabel({ displayName: profile?.displayName }),
          senderHandle: user.username,
          // A human-sent echo never carries an Agent id, and a human sender is never deleted.
          senderAgentId: undefined,
          senderUserId: user.id,
          senderDeleted: false,
          senderAvatarUrl: workspaceUserAvatarUrl(
            workspaceId,
            user.id,
            profile?.avatarObjectKey ?? null,
          ),
          body: message.body,
          // An ISO string, like the stream it joins (`mapBrowserMessage`).
          createdAt: message.createdAt.toISOString(),
          // DMs carry no mention structure; only channel bodies are normalized to token form.
          mentions: [],
          attachments: message.attachments,
          reactions: undefined,
          // A human-sent message never carries an action card (those are Agent-authored only).
          actionCard: undefined,
        };
      },
    );
  });

/** The viewer's own emoji reaction on a DM message; returns the message's fresh summaries, for a
 * tab opened before reactions had versions (`toggleDirectReaction`). */
export const toggleDirectMessageReaction = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationInputSchema.extend(toggleMessageReactionInputSchema.shape))
  .handler(async ({ context, data }) => {
    const { reactions } = await toggleDirectReaction(context, data);
    return reactions ?? undefined;
  });

export const loadTaskConversation = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationPageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new TaskConversationPages(db).page(workspaceId, user.id, data.conversationId, {
      beforeSequence: data.beforeSequence,
      afterSequence: data.afterSequence,
      limit: data.limit,
      includeViewerViews: true,
    });
  });

export const loadTaskConversationUpdates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(directConversationUpdatesInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new TaskConversationPages(db).updates(
      workspaceId,
      user.id,
      data.conversationId,
      data.afterSequence,
      { includeViewerViews: true },
    );
  });
