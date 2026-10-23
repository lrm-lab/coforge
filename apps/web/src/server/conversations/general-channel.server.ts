import type { Prisma } from "#src/generated/prisma/client";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import {
  appNotificationsPossible,
  attemptAppNotification,
  recordAppNotifications,
} from "#src/server/app-notifications/app-notifications.server";
import {
  channelMemberEvents,
  recordChannelMembersAdded,
} from "#src/server/app-notifications/channel-events.server";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";

/** Nested creation keeps a new Workspace's `#general` inside the Workspace creation write, with
 * its creator already in it. */
export function generalChannelForCreator(userId: string) {
  return {
    create: { channelName: "general", members: { create: { userId } } },
  };
}

/**
 * Puts every Workspace human and every public, live Agent in `#general`, creating the channel if
 * the Workspace has none. `#general` is the Workspace-wide channel: nobody leaves it, so anyone
 * whose row was soft-left is back in. Called from the write points that add someone to the
 * Workspace (`admitWorkspaceMember`, a new Agent); a new Workspace gets it through
 * `generalChannelForCreator`, and the 20260924040000 migration brought it back for older ones, so
 * reads never enroll.
 */
export async function enrollGeneralChannel(db: Prisma.TransactionClient, workspaceId: string) {
  const [createdGeneral] = await db.conversation.createManyAndReturn({
    data: { workspaceId, channelName: "general" },
    skipDuplicates: true,
    select: { id: true },
  });
  const general = await db.conversation.findUniqueOrThrow({
    where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
  });
  const members = await db.workspaceMembership.findMany({
    where: { workspaceId },
  });
  // New members start already-read: the badge counts only messages sent after enrollment,
  // never #general's pre-existing history (same rule as `join`/`addMembers`).
  const latest = await db.message.findFirst({
    where: { conversationId: general.id },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const readThroughSequence = latest?.sequence ?? 0;
  // The rows these writes return are the ones new to the channel: what apps are told about.
  const enrolledUsers = await db.conversationMember.createManyAndReturn({
    data: members.map(({ userId }) => ({
      workspaceId,
      conversationId: general.id,
      userId,
      readThroughSequence,
    })),
    skipDuplicates: true,
    select: { userId: true },
  });
  // A private Agent is never an active channel member, #general included; making it public
  // enrolls it again (see `PrismaChangeAgentVisibilityStore`).
  const memoryAgent = await db.workspaceMemoryAgent.findUnique({
    where: { workspaceId },
    select: { agentId: true },
  });
  // An app's bot is in no channel until a person adds it: it posts only where it was added.
  const agents = (
    await db.agent.findMany({
      where: {
        workspaceId,
        visibility: AGENT_VISIBILITY.PUBLIC,
        ...ACTIVE_AGENT_WHERE,
        ...ROSTER_AGENT_WHERE,
      },
      select: { id: true },
    })
  ).filter((agent) => agent.id !== memoryAgent?.agentId);
  const enrolledAgents = await db.conversationMember.createManyAndReturn({
    data: agents.map(({ id: agentId }) => ({
      workspaceId,
      conversationId: general.id,
      agentId,
      // An Agent joins #general muted, so ordinary chatter there does not wake every Agent in the
      // Workspace; a personal @mention still reaches it, and it may unmute.
      channelMuted: true,
    })),
    skipDuplicates: true,
    select: { agentId: true },
  });
  // Nobody leaves #general: anyone whose row was soft-left is back in, a human read through its
  // history like anyone joining, an Agent (as on any late join) able to read that history.
  const returnedUsers = await db.conversationMember.updateManyAndReturn({
    where: {
      conversationId: general.id,
      leftAt: { not: null },
      userId: { in: members.map(({ userId }) => userId) },
    },
    data: { leftAt: null, readThroughSequence },
    select: { userId: true },
  });
  const returnedAgents = await db.conversationMember.updateManyAndReturn({
    where: {
      conversationId: general.id,
      leftAt: { not: null },
      agentId: { in: agents.map(({ id }) => id) },
    },
    data: { leftAt: null },
    select: { agentId: true },
  });
  await recordAppNotifications(db, { id: workspaceId }, [
    ...(createdGeneral
      ? [
          {
            type: "workspace.public_channel_created" as const,
            data: { channel_id: general.id, name: "general" },
          },
        ]
      : []),
    ...channelMemberEvents(
      "channel.member_added",
      [general.id],
      ...[
        ...enrolledUsers.concat(returnedUsers).map(({ userId }) => ({ userId: userId! })),
        ...enrolledAgents.concat(returnedAgents).map(({ agentId }) => ({ agentId: agentId! })),
      ],
    ),
  ]);
  return general;
}

/** Puts one Agent that just became public back in `#general`, creating the channel if needed,
 * and returns the channel's id. The row is upserted so a first-time membership and a re-join
 * through a soft-left row are the same write; its read cursor and mute survive a re-join. */
export async function joinGeneralChannel(
  db: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
) {
  const general = await db.conversation.upsert({
    where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
    create: { workspaceId, channelName: "general" },
    update: {},
    select: { id: true },
  });
  // Whether it was already in is the emitter's own query: read only where apps can be told, in a
  // savepoint of its own (`null` is not in, `undefined` is unknown).
  const wasIn = appNotificationsPossible()
    ? await attemptAppNotification(db, () =>
        db.conversationMember.findFirst({
          where: { conversationId: general.id, agentId, ...ACTIVE_MEMBER_WHERE },
          select: { id: true },
        }),
      )
    : undefined;
  await db.conversationMember.upsert({
    where: { conversationId_agentId: { conversationId: general.id, agentId } },
    // Muted on first joining, like every Agent in #general; a re-join keeps its own setting.
    create: { workspaceId, conversationId: general.id, agentId, channelMuted: true },
    update: { leftAt: null },
  });
  if (wasIn === null) await recordChannelMembersAdded(db, workspaceId, general.id, [{ agentId }]);
  return general.id;
}
