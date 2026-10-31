import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { compareHumanLabels, humanLabel } from "#src/lib/human-label";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { memberChannel, type PublicChannelPorts } from "./channel-access.server";
import { mentionAffinityScores, type RecentMentionRow } from "./mentions.server";

/** What the composer's @-completion offers in a channel: its members, scored by the viewer's own
 * recent mentions, and the Workspace's people and public Agents outside it. */

/** The public profile of a member row that a mention completion shows. */
export const MENTIONABLE_MEMBER_SELECT = {
  user: {
    select: {
      id: true,
      username: true,
      displayName: true,
      description: true,
      avatarObjectKey: true,
    },
  },
  agent: {
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      avatarMascot: true,
    },
  },
} satisfies Prisma.ConversationMemberSelect;

type MentionableMemberRow = Prisma.ConversationMemberGetPayload<{
  select: typeof MENTIONABLE_MEMBER_SELECT;
}>;

/** Each member row as a mention completion, scored and ordered by handle. */
export function mentionables(
  workspaceId: string,
  rows: readonly MentionableMemberRow[],
  mentionScores: ReturnType<typeof mentionAffinityScores>,
) {
  return rows
    .map((row) =>
      row.user
        ? {
            kind: "user" as const,
            id: row.user.id,
            handle: row.user.username,
            label: humanLabel(row.user),
            description: row.user.description.trim(),
            avatarUrl: workspaceUserAvatarUrl(workspaceId, row.user.id, row.user.avatarObjectKey),
            mentionScore: mentionScores.get(`user:${row.user.id}`) ?? 0,
          }
        : {
            kind: "agent" as const,
            id: row.agent!.id,
            handle: row.agent!.name,
            label: row.agent!.displayName?.trim() || row.agent!.name,
            description: row.agent!.description.trim(),
            avatarUrl: agentAvatarUrl(row.agent!.id, row.agent!.avatarMascot),
            mentionScore: mentionScores.get(`agent:${row.agent!.id}`) ?? 0,
          },
    )
    .sort((left, right) => left.handle.localeCompare(right.handle));
}

/**
 * Read the viewer's latest 50 messages carrying mentions for mentionAffinityScores, keyed by
 * their membership (including soft-left rows). No membership means no prior mentions.
 * Walk messages(senderMemberId, sequence) with LATERAL mention lookups by message key;
 * filtering mention rows or using a relation filter makes PostgreSQL scan/hash the channel's
 * whole mention set. Message ordering is mention ordering because both are written together.
 */
export async function viewerRecentMentions(
  db: PrismaClient,
  memberId: string | undefined,
): Promise<RecentMentionRow[]> {
  if (!memberId) return [];
  return db.$queryRaw<RecentMentionRow[]>`
    SELECT mm."kind", mm."actorId"::text AS "actorId", mm."createdAt"
    FROM "messages" m
    CROSS JOIN LATERAL (
      SELECT mm."kind", mm."actorId", mm."createdAt" FROM "message_mentions" mm
      WHERE mm."messageId" = m."id" AND mm."conversationId" = m."conversationId"
      -- No message contributes more than the outer LIMIT anyway; this one keeps PostgreSQL
      -- from pulling the subquery up into the hash join the relation filter got.
      LIMIT 50
    ) mm
    WHERE m."senderMemberId" = ${memberId}::uuid
    ORDER BY m."sequence" DESC
    LIMIT 50`;
}

/**
 * The composer's @-completion directory for one channel, fetched on demand: every active
 * member (the viewer included, per #574 — this list also resolves stored mention tokens)
 * scored by the viewer's recent mentions. The conversation payload carries it once per
 * load, so members who join while the page is open would otherwise only appear after a
 * full refresh; the composer refetches this while the conversation stays open.
 */
export async function mentionDirectory(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
) {
  await memberChannel(db, workspaceId, userId, channelId);
  return conversationMentionables(db, workspaceId, userId, channelId);
}

/** Every active member of a conversation as a mention completion, scored by the viewer's recent
 * mentions there; whether the viewer may read it is the caller's to check. */
export async function conversationMentionables(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  conversationId: string,
) {
  const [mentionRows, viewerRow] = await Promise.all([
    db.conversationMember.findMany({
      where: { conversationId, ...ACTIVE_MEMBER_WHERE },
      select: MENTIONABLE_MEMBER_SELECT,
    }),
    db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { id: true },
    }),
  ]);
  const mentionScores = mentionAffinityScores(await viewerRecentMentions(db, viewerRow?.id));
  return mentionables(workspaceId, mentionRows, mentionScores);
}

/**
 * The composer's other @-completion group for one channel: the Workspace's people and public
 * Agents who are not active members, for the viewer to mention on purpose. Such a mention does
 * not notify them; the send records it as the viewer's pending mention action. Never the viewer,
 * a private Agent (it cannot join a channel) or a deleted one. People first, by label, then
 * Agents by handle; the composer ranks them against the query.
 */
export async function mentionOutsiders(
  { db }: PublicChannelPorts,
  workspaceId: string,
  userId: string,
  channelId: string,
) {
  await memberChannel(db, workspaceId, userId, channelId);
  const notMember = { conversationId: channelId, ...ACTIVE_MEMBER_WHERE };
  const [memberships, agents] = await Promise.all([
    db.workspaceMembership.findMany({
      where: {
        workspaceId,
        userId: { not: userId },
        user: { conversationMembers: { none: notMember } },
      },
      select: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            description: true,
            avatarObjectKey: true,
          },
        },
      },
    }),
    db.agent.findMany({
      where: {
        workspaceId,
        visibility: AGENT_VISIBILITY.PUBLIC,
        ...ACTIVE_AGENT_WHERE,
        conversations: { none: notMember },
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        avatarMascot: true,
      },
      orderBy: { name: "asc" },
    }),
  ]);
  return [
    ...memberships
      .map(({ user }) => user)
      .sort(compareHumanLabels)
      .map((user) => ({
        kind: "user" as const,
        id: user.id,
        handle: user.username,
        label: humanLabel(user),
        description: user.description.trim(),
        avatarUrl: workspaceUserAvatarUrl(workspaceId, user.id, user.avatarObjectKey),
        mentionScore: 0,
        outsider: true as const,
      })),
    ...agents.map((agent) => ({
      kind: "agent" as const,
      id: agent.id,
      handle: agent.name,
      label: agent.displayName?.trim() || agent.name,
      description: agent.description.trim(),
      avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
      mentionScore: 0,
      outsider: true as const,
    })),
  ];
}
