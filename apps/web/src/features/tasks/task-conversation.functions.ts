import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  attachmentIdsSchema,
  mentionSelectorsSchema,
} from "#src/features/conversations/conversation.schemas";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";

/** A task, by the board it sits on and its number there: the page knows both. */
const taskRefSchema = z.object({
  conversationId: z.uuid(),
  number: z.number().int().positive(),
});

const replySchema = taskRefSchema.extend({
  idempotencyKey: z.uuid(),
  body: z.string().trim().min(1).max(8_000),
  attachmentIds: attachmentIdsSchema.optional(),
  mentions: mentionSelectorsSchema,
});

const followSchema = taskRefSchema.extend({ follow: z.boolean() });

function taskConversations(db: ConstructorParameters<typeof TaskConversations>[0]["db"]) {
  const centrifugo = createCentrifugoServerApi();
  return new TaskConversations(
    {
      db,
      reader: "people",
      dependencies: {
        publisher: centrifugo,
        realtime: new CentrifugoConversationRealtime(centrifugo),
      },
    },
    getMessageRequestIdempotency(),
  );
}

export const replyToTask = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(replySchema)
  .handler(async ({ context: { db, user, workspaceId }, data }) => {
    const { conversationId, number, ...input } = data;
    return taskConversations(db).reply(
      { workspaceId, userId: user.id },
      { conversationId, number },
      input,
    );
  });

export const openTaskConversation = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(taskRefSchema)
  .handler(async ({ context: { db, user, workspaceId }, data }) =>
    taskConversations(db).open({ workspaceId, userId: user.id }, data),
  );

export const setTaskFollow = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(followSchema)
  .handler(async ({ context: { db, user, workspaceId }, data }) => {
    const { follow, ...ref } = data;
    const principal = { workspaceId, userId: user.id };
    const conversations = taskConversations(db);
    return follow ? conversations.follow(principal, ref) : conversations.unfollow(principal, ref);
  });

export const markTaskConversationRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(taskRefSchema.extend({ throughSequence: z.number().int().positive() }))
  .handler(async ({ context: { db, user, workspaceId }, data }) => {
    const { throughSequence, ...ref } = data;
    return taskConversations(db).markRead({ workspaceId, userId: user.id }, ref, throughSequence);
  });
