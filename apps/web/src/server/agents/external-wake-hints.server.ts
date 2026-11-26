import type { WakeHint, WakeHintFlag, WakeHintSenderType } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { unreadAgentMessagesFragment } from "#src/server/db/repositories/agent-attention.repositories.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import {
  TARGET_CONVERSATION_SELECT,
  conversationTarget,
  deliveryTarget,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";

export const WAKE_HINT_LIMIT = 100;

type HintRow = {
  conversationId: string;
  threadRootId: string | null;
  pendingCount: number;
  firstPendingMsgId: string;
  latestMsgId: string;
  latestSeq: number;
  latestSenderName: string | null;
  latestSenderType: WakeHintSenderType;
  mentioned: boolean;
  outsideMention: boolean;
};

type HintDb = Pick<
  PrismaClient,
  "$queryRaw" | "conversation" | "user" | "agent" | "workspaceMembership"
> &
  Partial<Pick<PrismaClient, "app">>;

export async function listWakeHints(
  db: HintDb,
  scope: { workspaceId: string; agentId: string },
): Promise<WakeHint[]> {
  const { workspaceId, agentId } = scope;
  const rows = await db.$queryRaw<HintRow[]>`
    WITH unread AS (${unreadAgentMessagesFragment(workspaceId, agentId)}),
    flagged AS (
      SELECT u.*, (u."nonMemberMention" OR EXISTS (
        SELECT 1 FROM "message_mentions" mm
        JOIN "conversation_members" mem ON mem."id" = mm."memberId"
        WHERE mm."messageId" = u."id" AND mem."agentId" = ${agentId}::uuid
      )) AS "mentioned"
      FROM unread u
    )
    SELECT "conversationId"::text AS "conversationId", "threadRootId"::text AS "threadRootId",
      count(*)::int AS "pendingCount",
      (array_agg("id"::text ORDER BY "sequence" ASC))[1] AS "firstPendingMsgId",
      (array_agg("id"::text ORDER BY "sequence" DESC))[1] AS "latestMsgId",
      max("sequence")::int AS "latestSeq",
      (array_agg(COALESCE("senderUsername", "senderAgentName") ORDER BY "sequence" DESC))[1] AS "latestSenderName",
      (array_agg(CASE WHEN "senderUsername" IS NOT NULL THEN 'human'
                      WHEN "senderAgentName" IS NOT NULL THEN 'agent'
                      ELSE 'system' END ORDER BY "sequence" DESC))[1] AS "latestSenderType",
      bool_or("mentioned") AS "mentioned",
      bool_or("nonMemberMention") AS "outsideMention"
    FROM flagged
    GROUP BY "conversationId", "threadRootId"
    ORDER BY max("createdAt") DESC, "conversationId", "threadRootId"
    LIMIT ${WAKE_HINT_LIMIT}`;
  if (rows.length === 0) return [];
  const conversations = await db.conversation.findMany({
    where: { workspaceId, id: { in: [...new Set(rows.map((row) => row.conversationId))] } },
    select: TARGET_CONVERSATION_SELECT,
  });
  const targetOf = await directTargets(db, workspaceId, agentId, conversations);
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  return rows.flatMap((row) => {
    const conversation = byId.get(row.conversationId);
    if (!conversation) return [];
    const named =
      conversation.channelName !== null ||
      conversation.taskDiscussionOf !== null ||
      conversation.attachmentCommentThread !== null ||
      targetOf(conversation) !== undefined;
    const channelType: WakeHint["channelType"] = conversation.taskDiscussionOf
      ? "task"
      : conversation.attachmentCommentThread
        ? "attachment"
        : conversation.channelName !== null
          ? "channel"
          : "dm";
    const flags: WakeHintFlag[] = [];
    if (row.mentioned) flags.push("mention");
    if (row.outsideMention) flags.push("non_member_mention");
    if (channelType === "dm") flags.push("dm");
    if (row.threadRootId) flags.push("thread");
    if (channelType === "task") flags.push("task");
    return [
      {
        target: named
          ? deliveryTarget(conversationTarget(conversation, targetOf), row.threadRootId)
          : null,
        channelId: row.conversationId,
        channelType,
        pendingCount: row.pendingCount,
        firstPendingMsgId: row.firstPendingMsgId,
        latestMsgId: row.latestMsgId,
        latestSeq: String(row.latestSeq),
        latestSenderName: row.latestSenderName,
        latestSenderType: row.latestSenderType,
        flags,
      } satisfies WakeHint,
    ];
  });
}
