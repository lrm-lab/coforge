import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { authorizeConversationRealtime } from "#src/server/conversations/conversation-realtime-access.server";
import {
  issueBrowserRealtimeToken,
  issueConversationRealtimeToken,
  issueUserConversationSubscriptionToken,
  issueWorkspaceConversationSubscriptionToken,
  issueWorkspacePresenceSubscriptionToken,
} from "#src/server/auth/browser-realtime-token.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";

export const getBrowserRealtimeConnectionToken = createServerFn({
  method: "GET",
})
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueBrowserRealtimeToken({ userId: user.id, workspaceId });
  });

export const getConversationRealtimeToken = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    const conversationId = await authorizeConversationRealtime(db, {
      workspaceId,
      userId: user.id,
      conversationId: data.conversationId,
    });
    return issueConversationRealtimeToken({
      userId: user.id,
      conversationId,
    });
  });

/** Subscription token for the Workspace-level conversation signal channel (unread badges). */
export const getWorkspaceConversationSubscriptionToken = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueWorkspaceConversationSubscriptionToken({ userId: user.id, workspaceId });
  });

/**
 * Subscription token for the caller's own direct-message signal channel. It is issued for the
 * authenticated user only, so it can never subscribe to another user's DM signals.
 */
export const getUserConversationSubscriptionToken = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    return issueUserConversationSubscriptionToken({ userId: context.user.id });
  });

/** Subscription token for the Workspace presence channel. */
export const getWorkspacePresenceSubscriptionToken = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueWorkspacePresenceSubscriptionToken({ userId: user.id, workspaceId });
  });
