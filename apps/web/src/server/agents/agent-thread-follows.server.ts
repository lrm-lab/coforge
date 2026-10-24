import { threadReferenceText } from "@lrm/coforge-sdk/internal";
import type { AgentFollowedThread } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  ACTIVE_MEMBER_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";

/**
 * The channel threads an Agent follows as an active member, newest follow first. Raft lists a
 * reason and a done time for each follow; CoForge records only when a member began following a
 * thread, so a row is its target, its channel and that time.
 */
export async function listAgentFollowedThreads(
  db: Pick<PrismaClient, "threadFollow">,
  workspaceId: string,
  agentId: string,
): Promise<AgentFollowedThread[]> {
  const follows = await db.threadFollow.findMany({
    where: {
      workspaceId,
      member: { agentId, ...ACTIVE_MEMBER_WHERE },
      root: { conversation: { channelName: { not: null }, ...VISIBLE_CONVERSATION_WHERE } },
    },
    select: {
      createdAt: true,
      rootMessageId: true,
      root: { select: { conversation: { select: { channelName: true } } } },
    },
    orderBy: [{ createdAt: "desc" }, { rootMessageId: "desc" }],
  });
  return follows.map(({ createdAt, rootMessageId, root }) => {
    const channel = root.conversation.channelName ?? "";
    return {
      target: threadReferenceText(channel, rootMessageId),
      parentChannel: `#${channel}`,
      rootMessageId,
      followedAt: createdAt.toISOString(),
    };
  });
}
