import type { PrismaClient } from "#src/generated/prisma/client";
import type { HumanNames } from "#src/lib/human-label";
import {
  activeMemberRows,
  latestTopLevelMessageRows,
} from "#src/server/db/repositories/channel-list-preview.repositories.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import { messagePreviewLine } from "#src/server/conversations/message-preview-line.server";
import type { MessageMentionRef } from "#src/server/conversations/mentions.server";

/** How many members a channel row shows, in join order. */
export const CHANNEL_LIST_MEMBER_LIMIT = 6;

export type ChannelListSender = {
  kind: "user" | "agent" | "system";
  name: string;
  /** The sender is the viewer's own member row. */
  mine: boolean;
};

export type ChannelListLastMessage = {
  createdAt: string;
  preview: string;
  sender: ChannelListSender;
};

export type ChannelListMember = {
  kind: "user" | "agent";
  id: string;
  name: string;
  avatarUrl: string | null;
};

/** The names a sender or member is shown by, keyed by user id and agent id. */
export type ChannelListNames = {
  users: ReadonlyMap<string, HumanNames>;
  agents: ReadonlyMap<string, { name: string; displayName: string | null }>;
};

/**
 * Who sent a channel's last message, as the list shows it: a person or an Agent named as the
 * browser names every sender, or the system when the message has no sender member. `mine` is
 * true only when the sender is the viewer.
 */
export function previewSenderOf(
  row: { senderUserId: string | null; senderAgentId: string | null },
  viewerUserId: string,
  names: ChannelListNames,
): ChannelListSender {
  if (row.senderUserId) {
    const user = names.users.get(row.senderUserId);
    return {
      kind: "user",
      name: browserSenderName(user ? { user } : null),
      mine: row.senderUserId === viewerUserId,
    };
  }
  if (row.senderAgentId) {
    const agent = names.agents.get(row.senderAgentId);
    return {
      kind: "agent",
      name: browserSenderName(agent ? { agent } : null),
      mine: false,
    };
  }
  return { kind: "system", name: browserSenderName(null), mine: false };
}

/**
 * Each listed channel's last message and first active members, by conversation id. Everything
 * loads in a fixed number of queries whatever the channel count: the latest messages, their
 * mentions, the active members, and one name and avatar read per person and Agent involved.
 */
export async function channelListPreviews(
  db: PrismaClient,
  workspaceId: string,
  conversationIds: readonly string[],
  viewerUserId: string,
) {
  const [latest, members] = await Promise.all([
    latestTopLevelMessageRows(db, conversationIds),
    activeMemberRows(db, conversationIds, CHANNEL_LIST_MEMBER_LIMIT),
  ]);
  const mentionRows = latest.length
    ? await db.messageMention.findMany({
        where: { messageId: { in: latest.map((row) => row.messageId) } },
        select: { messageId: true, kind: true, actorId: true, handle: true },
      })
    : [];
  const mentionsByMessage = new Map<string, MessageMentionRef[]>();
  for (const { messageId, kind, actorId, handle } of mentionRows) {
    const mentions = mentionsByMessage.get(messageId) ?? [];
    mentions.push({ kind, actorId, handle });
    mentionsByMessage.set(messageId, mentions);
  }

  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const row of latest) {
    if (row.senderUserId) userIds.add(row.senderUserId);
    if (row.senderAgentId) agentIds.add(row.senderAgentId);
  }
  for (const row of members) {
    if (row.userId) userIds.add(row.userId);
    if (row.agentId) agentIds.add(row.agentId);
  }
  const [users, agents] = await Promise.all([
    userIds.size
      ? db.user.findMany({
          where: { id: { in: [...userIds] } },
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarObjectKey: true,
          },
        })
      : [],
    agentIds.size
      ? db.agent.findMany({
          where: { id: { in: [...agentIds] } },
          select: { id: true, name: true, displayName: true, avatarObjectKey: true },
        })
      : [],
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const names: ChannelListNames = {
    users: userById,
    agents: agentById,
  };

  const result = new Map<
    string,
    { lastMessage: ChannelListLastMessage | null; members: ChannelListMember[] }
  >(conversationIds.map((id) => [id, { lastMessage: null, members: [] }]));
  for (const row of latest) {
    const entry = result.get(row.conversationId);
    if (!entry) continue;
    entry.lastMessage = {
      createdAt: row.createdAt.toISOString(),
      preview: messagePreviewLine(row.body, mentionsByMessage.get(row.messageId) ?? []),
      sender: previewSenderOf(row, viewerUserId, names),
    };
  }
  for (const row of members) {
    const entry = result.get(row.conversationId);
    if (!entry) continue;
    if (row.userId) {
      const user = userById.get(row.userId);
      if (!user) continue;
      entry.members.push({
        kind: "user",
        id: user.id,
        name: browserSenderName({ user }),
        avatarUrl: workspaceUserAvatarUrl(workspaceId, user.id, user.avatarObjectKey),
      });
    } else if (row.agentId) {
      const agent = agentById.get(row.agentId);
      if (!agent) continue;
      entry.members.push({
        kind: "agent",
        id: agent.id,
        name: browserSenderName({ agent }),
        avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
      });
    }
  }
  return result;
}
