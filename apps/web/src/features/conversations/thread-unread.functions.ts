import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import {
  loadThreadUnreadSnapshot,
  markThreadUnread,
  threadUnreadRealtime,
} from "#src/server/conversations/thread-unread-marks.server";

function threadUnreadScope({ workspaceId, user }: WorkspaceUserContext, conversationId: string) {
  return { workspaceId, userId: user.id, conversationId };
}

const conversationInput = z.object({ conversationId: z.uuid() });

export const markConversationThreadUnread = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(conversationInput.extend({ rootMessageId: z.uuid() }))
  .handler(({ context, data }) =>
    markThreadUnread(
      context.db,
      threadUnreadRealtime(),
      threadUnreadScope(context, data.conversationId),
      data.rootMessageId,
    ),
  );

export const loadConversationThreadUnreadSnapshot = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(conversationInput)
  .handler(({ context, data }) =>
    loadThreadUnreadSnapshot(context.db, threadUnreadScope(context, data.conversationId)),
  );
