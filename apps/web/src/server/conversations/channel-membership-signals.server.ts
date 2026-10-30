import type { PrismaClient } from "#src/generated/prisma/client";
import {
  announceBestEffort,
  announceMemberChanged,
  announceViewerEvent,
  type ConversationRealtime,
  type RevokedConversations,
} from "./conversation-realtime.server";
import { withTaskDiscussions } from "./task-discussion-revoke.server";

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
    /** Lets a leaver's subscriptions to the channel's task conversations end with the channel's. */
    db?: Pick<PrismaClient, "task">;
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
          db: input.db,
        })
      : undefined,
  ]);
}

/** Ends these people's subscriptions to conversations they no longer read (`revokeConversations`),
 * once the write has committed. Best effort like `announceMemberChanged`: a subscription it misses
 * ends when its token next renews, which the read rule refuses. */
export async function announceConversationsRevoked(
  realtime: Pick<ConversationRealtime, "revokeConversations"> | undefined,
  input: { workspaceId: string; db?: Pick<PrismaClient, "task"> } & RevokedConversations,
): Promise<void> {
  const { workspaceId, db, ...revoked } = input;
  if (revoked.userIds.length === 0 || revoked.conversationIds.length === 0) return;
  // The task conversations of the channels go with them; a failed lookup revokes the channels alone,
  // and the rest end at the next token renewal, which the read rule refuses.
  const conversationIds = db
    ? await withTaskDiscussions(db, revoked.conversationIds).catch(() => revoked.conversationIds)
    : revoked.conversationIds;
  await announceBestEffort(
    realtime,
    (port) => port.revokeConversations?.({ ...revoked, conversationIds }),
    {
      name: "conversation_revoked",
      workspace_id: workspaceId,
    },
  );
}
