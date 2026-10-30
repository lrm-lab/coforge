import type { PrismaClient } from "#src/generated/prisma/client";
import type { WorkspaceInfoChannel, WorkspaceInfoComputer } from "@lrm/coforge-sdk/internal";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  channelActorMemberWhere,
  type ChannelActor,
} from "#src/server/conversations/channel-actor.server";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { channelVisibilityOf } from "#src/features/conversations/channel-visibility";
import { deriveChannelAuthority } from "#src/server/conversations/channel-authority.server";

/**
 * The Workspace's channels as one Agent sees them, for `coforge workspace info --channels`: every
 * channel its reader (`agentChannelReader`) may read (`visibleChannelWhere`: the public ones and the
 * private ones it is in), with the reader's own membership, mute and channel authority. Two reads however many channels there are:
 * the channels with the Agent's own member row, and the newest message of each channel in one
 * lateral lookup. The caller reads the Agent's Workspace role once.
 */
export async function listAgentWorkspaceChannels(
  db: PrismaClient,
  workspaceId: string,
  reader: ChannelActor,
  serverRole: string | undefined,
): Promise<WorkspaceInfoChannel[]> {
  const channels = await db.conversation.findMany({
    where: visibleChannelWhere(workspaceId, reader),
    orderBy: { channelName: "asc" },
    select: {
      id: true,
      channelName: true,
      description: true,
      visibility: true,
      archivedAt: true,
      members: {
        where: { ...channelActorMemberWhere(reader), ...ACTIVE_MEMBER_WHERE },
        select: { channelRole: true, channelMuted: true },
        take: 1,
      },
    },
  });
  if (channels.length === 0) return [];
  // One index probe per channel for its newest message (`messages(conversationId, createdAt)`),
  // so the cost follows the number of channels and not the number of messages.
  const newest = await db.$queryRaw<{ conversationId: string; lastPostAt: Date }[]>`
    SELECT c."id" AS "conversationId", p."createdAt" AS "lastPostAt"
    FROM unnest(${channels.map((channel) => channel.id)}::uuid[]) AS c("id")
    CROSS JOIN LATERAL (
      SELECT m."createdAt" FROM "messages" m
      WHERE m."conversationId" = c."id" AND m."senderMemberId" IS NOT NULL
      ORDER BY m."createdAt" DESC LIMIT 1
    ) p`;
  const lastPostAt = new Map(newest.map((row) => [row.conversationId, row.lastPostAt]));
  return channels.map((channel) => {
    const member = channel.members[0];
    const authority = deriveChannelAuthority(reader, channel, serverRole, member);
    return {
      name: `#${channel.channelName}`,
      description: channel.description,
      visibility: channelVisibilityOf(channel),
      joined: Boolean(member),
      muted: member?.channelMuted ?? false,
      archived: channel.archivedAt !== null,
      ...(authority.channelRole ? { channelRole: authority.channelRole } : {}),
      ...(authority.adminBasis ? { channelAdminBasis: authority.adminBasis } : {}),
      lastPostAt: lastPostAt.get(channel.id)?.toISOString() ?? null,
    };
  });
}

/** The Computers connected to the Workspace with their live connection status, in one status read. */
export async function listWorkspaceComputers(
  db: PrismaClient,
  workspaceId: string,
): Promise<WorkspaceInfoComputer[]> {
  const rows = await db.workspaceComputer.findMany({
    where: { workspaceId, computer: { deletedAt: null } },
    orderBy: { computer: { name: "asc" } },
    select: {
      computer: {
        select: {
          id: true,
          name: true,
          displayName: true,
          platform: true,
          osVersion: true,
          computerVersion: true,
        },
      },
    },
  });
  if (rows.length === 0) return [];
  let online: boolean[] | undefined;
  try {
    online = await getComputerStatusCache().getMany(
      rows.map(({ computer }) => ({ workspaceId, computerId: computer.id })),
    );
  } catch {
    // An unreadable status cache never fails workspace info; it leaves every status "unknown".
  }
  return rows.map(({ computer }, index) => ({
    name: computer.name,
    displayName: computer.displayName,
    status: online ? (online[index] ? "online" : "offline") : "unknown",
    ...(computer.platform ? { platform: computer.platform } : {}),
    ...(computer.osVersion ? { osVersion: computer.osVersion } : {}),
    ...(computer.computerVersion ? { computerVersion: computer.computerVersion } : {}),
  }));
}
