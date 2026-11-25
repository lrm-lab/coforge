import type { PrismaClient } from "#src/generated/prisma/client";
import type { HumanNames } from "#src/lib/human-label";
import {
  activeMemberRows,
  latestTopLevelMessageRows,
  type ActiveMemberRow,
} from "#src/server/db/repositories/channel-list-preview.repositories.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import type { PreviewCard } from "#src/features/conversations/action-card-preview";
import { previewNoticeOf, type PreviewNotice } from "#src/features/conversations/preview-line";
import { previewCardFieldOf } from "#src/server/conversations/action-card-preview.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";
import {
  messagePreviewLine,
  type PreviewMentionRef,
} from "#src/server/conversations/message-preview-line.server";
import {
  BROWSER_MESSAGE_MENTIONS_SELECT,
  browserMessageMention,
} from "#src/server/conversations/mentions.server";

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
  /** Set when the message is a system notice: what the browser renders it from in the viewer's
   * language, `preview` being its stored English. */
  notice?: PreviewNotice;
  /** Set when the message is an action card: what the browser writes its line from in the
   * viewer's language, `preview` being its stored English. */
  card?: PreviewCard;
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
  sharedMembers?: Promise<ChannelListMemberDetails>,
) {
  const latest = latestTopLevelMessageRows(db, conversationIds);
  const members = sharedMembers ?? activeMemberRows(db, conversationIds, CHANNEL_LIST_MEMBER_LIMIT);
  const mentions = latest.then(async (rows) => {
    const mentionRows = rows.length
      ? await db.messageMention.findMany({
          where: { messageId: { in: rows.map((row) => row.messageId) } },
          select: { messageId: true, ...BROWSER_MESSAGE_MENTIONS_SELECT.select },
        })
      : [];
    const byMessage = new Map<string, PreviewMentionRef[]>();
    for (const row of mentionRows) {
      const refs = byMessage.get(row.messageId) ?? [];
      refs.push(browserMessageMention(row));
      byMessage.set(row.messageId, refs);
    }
    return byMessage;
  });
  const people = Promise.all([latest, members]).then(([rows, people]) =>
    Array.isArray(people)
      ? readChannelListPeople(db, [...rows.map(messageSender), ...people])
      : readChannelListPeople(db, rows.map(messageSender), people.names),
  );
  const [messages, memberDetails, mentionsByMessage, names] = await Promise.all([
    latest,
    members,
    mentions,
    people,
  ]);

  const result = new Map<
    string,
    { lastMessage: ChannelListLastMessage | null; members: ChannelListMember[] }
  >(conversationIds.map((id) => [id, { lastMessage: null, members: [] }]));
  for (const row of messages) {
    const entry = result.get(row.conversationId);
    if (!entry) continue;
    entry.lastMessage = {
      createdAt: row.createdAt.toISOString(),
      preview: messagePreviewLine(
        row.body,
        mentionsByMessage.get(row.messageId) ?? [],
        row.forwardedBody,
      ),
      ...previewNoticeOf(row.noticeKind, row.noticeParams),
      ...previewCardFieldOf(row.card),
      sender: previewSenderOf(row, viewerUserId, names),
    };
  }
  const collages = Array.isArray(memberDetails)
    ? memberCollages(workspaceId, conversationIds, memberDetails, names)
    : memberDetails.collages;
  for (const [id, entry] of result) entry.members = collages.get(id) ?? [];
  return result;
}

/**
 * Each channel's first active members, by conversation id, as its collage avatar shows them: the
 * members `channelListPreviews` gives the Chat sidebar's row, for a surface that shows no preview.
 * A fixed number of queries whatever the channel count: the active members, then one name and
 * avatar read per person and Agent among them.
 */
export async function channelListMembers(
  db: PrismaClient,
  workspaceId: string,
  conversationIds: readonly string[],
) {
  return (await channelListMemberDetails(db, workspaceId, conversationIds)).collages;
}

type ChannelActorIds = { userId: string | null; agentId: string | null };
type ChannelListPeople = {
  users: ReadonlyMap<string, ChannelListMemberUser>;
  agents: ReadonlyMap<string, ChannelListMemberAgent>;
};
type ChannelListMemberDetails = {
  names: ChannelListPeople;
  collages: Map<string, ChannelListMember[]>;
};

export async function channelListMemberDetails(
  db: PrismaClient,
  workspaceId: string,
  conversationIds: readonly string[],
): Promise<ChannelListMemberDetails> {
  const rows = await activeMemberRows(db, conversationIds, CHANNEL_LIST_MEMBER_LIMIT);
  const names = await readChannelListPeople(db, rows);
  return { names, collages: memberCollages(workspaceId, conversationIds, rows, names) };
}

function messageSender(row: { senderUserId: string | null; senderAgentId: string | null }) {
  return { userId: row.senderUserId, agentId: row.senderAgentId };
}

async function readChannelListPeople(
  db: PrismaClient,
  rows: Iterable<ChannelActorIds>,
  known?: ChannelListPeople,
): Promise<ChannelListPeople> {
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const { userId, agentId } of rows) {
    if (userId && !known?.users.has(userId)) userIds.add(userId);
    if (agentId && !known?.agents.has(agentId)) agentIds.add(agentId);
  }
  if (known && !userIds.size && !agentIds.size) return known;
  const [users, agents] = await Promise.all([
    userIds.size
      ? db.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, username: true, displayName: true, avatarObjectKey: true },
        })
      : [],
    agentIds.size
      ? db.agent.findMany({
          where: { id: { in: [...agentIds] } },
          select: {
            id: true,
            name: true,
            displayName: true,
            avatarMascot: true,
            appBot: APP_BOT_LOGO_SELECT,
          },
        })
      : [],
  ]);
  const userById = new Map(known?.users);
  const agentById = new Map(known?.agents);
  for (const user of users) userById.set(user.id, user);
  for (const agent of agents) agentById.set(agent.id, agent);
  return { users: userById, agents: agentById };
}

function memberCollages(
  workspaceId: string,
  conversationIds: readonly string[],
  rows: readonly ActiveMemberRow[],
  names: ChannelListPeople,
) {
  const collages = new Map<string, ChannelListMember[]>(conversationIds.map((id) => [id, []]));
  for (const row of rows) {
    const member = channelListMember(workspaceId, row, names.users, names.agents);
    if (member) collages.get(row.conversationId)?.push(member);
  }
  return collages;
}

type ChannelListMemberUser = {
  id: string;
  username: string;
  displayName: string;
  avatarObjectKey: string | null;
};
type ChannelListMemberAgent = {
  id: string;
  name: string;
  displayName: string;
  avatarMascot: string | null;
  appBot: {
    installation: {
      app: { key: string; ownerWorkspaceId: string; logoObjectKey: string | null };
    };
  } | null;
};

/** One active member row as a channel's collage shows it, or null when its person or Agent is
 * gone. */
function channelListMember(
  workspaceId: string,
  row: { userId: string | null; agentId: string | null },
  userById: ReadonlyMap<string, ChannelListMemberUser>,
  agentById: ReadonlyMap<string, ChannelListMemberAgent>,
): ChannelListMember | null {
  if (row.userId) {
    const user = userById.get(row.userId);
    if (!user) return null;
    return {
      kind: "user",
      id: user.id,
      name: browserSenderName({ user }),
      avatarUrl: workspaceUserAvatarUrl(workspaceId, user.id, user.avatarObjectKey),
    };
  }
  if (row.agentId) {
    const agent = agentById.get(row.agentId);
    if (!agent) return null;
    return {
      kind: "agent",
      id: agent.id,
      name: browserSenderName({ agent }),
      avatarUrl: agentFaceUrl(agent),
    };
  }
  return null;
}
