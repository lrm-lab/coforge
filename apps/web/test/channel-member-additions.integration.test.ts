import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PublicChannels,
  enrollGeneralChannel,
} from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { isAppError } from "#src/lib/app-error";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { addMembersReportingRefusals } from "#src/server/conversations/channel-member-additions.server";

/**
 * Adding members from a channel's settings tries the whole batch in one write, then each picked
 * person and Agent on its own if one is refused: the valid ones join and the rest come back as
 * failures with a stable reason, while a refusal of the whole channel (archived, caller not a
 * member) still adds nobody. `PublicChannels.addMembers`, which the Agent CLI and channel creation
 * call, stays all-or-nothing. Drives the real `PublicChannels` against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = (name: string) =>
    db.user.create({
      data: { displayName: `cma-${name}-${suffix}`, username: `cma-${name}-${suffix}` },
    });
  const [creator, ada, outsider] = await Promise.all([
    user("creator"),
    user("ada"),
    user("outsider"),
  ]);
  const workspace = await db.workspace.create({
    data: {
      slug: `cma-${suffix}`,
      name: "Channel member additions",
      members: {
        create: [
          { userId: creator.id, role: "owner" },
          { userId: ada.id, role: "member" },
          { userId: outsider.id, role: "member" },
        ],
      },
    },
  });
  await enrollGeneralChannel(db, workspace.id);
  const agent = (name: string, visibility: string) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: creator.id,
        runtimeConfig: {},
        visibility,
      },
    });
  const [scout, ghost] = await Promise.all([
    agent("scout", AGENT_VISIBILITY.PUBLIC),
    agent("ghost", AGENT_VISIBILITY.PRIVATE),
  ]);
  // Each write that adds someone announces once; counting the announcements counts the writes.
  const memberChanges: string[] = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged(input) {
      memberChanges.push(...input.conversationIds);
    },
  };
  const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
  const team = await channels.create(workspace.id, creator.id, `team-${suffix}`);
  memberChanges.length = 0;
  return { db, channels, memberChanges, workspace, creator, ada, outsider, scout, ghost, team };
}

async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}

async function appErrorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

async function activeMemberIds(db: PrismaClient, conversationId: string) {
  const rows = await db.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true, agentId: true },
  });
  return rows.flatMap((row) => [row.userId, row.agentId].filter((id) => id !== null));
}

test.skipIf(!connectionString)(
  "a valid person joins while a private Agent picked with them is reported, not fatal",
  async () => {
    const { db, channels, workspace, creator, ada, outsider, scout, ghost, team } = await setup();
    try {
      const result = await addMembersReportingRefusals(
        channels,
        workspace.id,
        { userId: creator.id },
        team.id,
        {
          userIds: [ada.id],
          agentIds: [ghost.id],
        },
      );

      expect(result.failed).toEqual([{ kind: "agent", id: ghost.id, reason: "agent_private" }]);
      expect(result.members.humans.map((human) => human.id).sort()).toEqual(
        [creator.id, ada.id].sort(),
      );
      expect(result.members.agents.map((agent) => agent.id)).not.toContain(ghost.id);
      expect(result.members.candidates.humans.map((human) => human.id)).not.toContain(ada.id);
      expect(await activeMemberIds(db, team.id)).not.toContain(ghost.id);

      // Each kind of refusal carries its own reason; an already-active member is a quiet success.
      const stranger = crypto.randomUUID();
      const second = await addMembersReportingRefusals(
        channels,
        workspace.id,
        { userId: creator.id },
        team.id,
        {
          userIds: [ada.id, stranger],
          agentIds: [scout.id],
        },
      );
      expect(second.failed).toEqual([{ kind: "user", id: stranger, reason: "not_in_workspace" }]);
      expect(second.members.agents.map((agent) => agent.id)).toContain(scout.id);

      await db.agent.update({ where: { id: scout.id }, data: { deletedAt: new Date() } });
      const third = await addMembersReportingRefusals(
        channels,
        workspace.id,
        { userId: creator.id },
        team.id,
        {
          userIds: [],
          agentIds: [scout.id],
        },
      );
      expect(third.failed).toEqual([{ kind: "agent", id: scout.id, reason: "agent_inactive" }]);
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id, outsider.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "when every pick is refused, nobody joins and each pick is reported",
  async () => {
    const { db, channels, workspace, creator, ada, outsider, ghost, team } = await setup();
    const before = await activeMemberIds(db, team.id);
    try {
      const stranger = crypto.randomUUID();
      const result = await addMembersReportingRefusals(
        channels,
        workspace.id,
        { userId: creator.id },
        team.id,
        {
          userIds: [stranger],
          agentIds: [ghost.id],
        },
      );

      expect(result.failed).toEqual([
        { kind: "user", id: stranger, reason: "not_in_workspace" },
        { kind: "agent", id: ghost.id, reason: "agent_private" },
      ]);
      expect(await activeMemberIds(db, team.id)).toEqual(before);
      expect(
        [...result.members.humans, ...result.members.agents].map((member) => member.id).sort(),
      ).toEqual([...before].sort());
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id, outsider.id]);
    }
  },
);

test.skipIf(!connectionString)("a batch every pick can join is added in one write", async () => {
  const { db, channels, memberChanges, workspace, creator, ada, outsider, scout, team } =
    await setup();
  try {
    const result = await addMembersReportingRefusals(
      channels,
      workspace.id,
      { userId: creator.id },
      team.id,
      {
        userIds: [ada.id, outsider.id],
        agentIds: [scout.id],
      },
    );

    expect(result.failed).toEqual([]);
    expect(result.members.humans.map((human) => human.id).sort()).toEqual(
      [creator.id, ada.id, outsider.id].sort(),
    );
    expect(result.members.agents.map((agent) => agent.id)).toContain(scout.id);
    expect(memberChanges).toEqual([team.id]);
  } finally {
    await teardown(db, workspace.id, [creator.id, ada.id, outsider.id]);
  }
});

test.skipIf(!connectionString)(
  "an archived channel refuses the whole request with CONFLICT and adds nobody",
  async () => {
    const { db, channels, workspace, creator, ada, outsider, ghost, team } = await setup();
    // Channel creation may enrol the Workspace Memory Agent; nobody else may join.
    const before = await activeMemberIds(db, team.id);
    try {
      await channels.setArchived(workspace.id, { userId: creator.id }, team.id, true);

      expect(
        await appErrorCode(
          addMembersReportingRefusals(channels, workspace.id, { userId: creator.id }, team.id, {
            userIds: [ada.id],
            agentIds: [ghost.id],
          }),
        ),
      ).toBe("CONFLICT");
      expect(await activeMemberIds(db, team.id)).toEqual(before);
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id, outsider.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a caller who is not an active member of the channel is refused with ACCESS_DENIED",
  async () => {
    const { db, channels, workspace, creator, ada, outsider, ghost, team } = await setup();
    // Channel creation may enrol the Workspace Memory Agent; nobody else may join.
    const before = await activeMemberIds(db, team.id);
    try {
      expect(
        await appErrorCode(
          addMembersReportingRefusals(channels, workspace.id, { userId: outsider.id }, team.id, {
            userIds: [ada.id],
            agentIds: [ghost.id],
          }),
        ),
      ).toBe("ACCESS_DENIED");
      expect(await activeMemberIds(db, team.id)).toEqual(before);
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id, outsider.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "PublicChannels.addMembers (the Agent CLI and channel creation path) stays all-or-nothing",
  async () => {
    const { db, channels, workspace, creator, ada, outsider, ghost, team } = await setup();
    // Channel creation may enrol the Workspace Memory Agent; nobody else may join.
    const before = await activeMemberIds(db, team.id);
    try {
      const error = await channels
        .addMembers(workspace.id, { userId: creator.id }, team.id, {
          userIds: [ada.id],
          agentIds: [ghost.id],
        })
        .catch((cause: unknown) => cause);

      expect(isAppError(error) && error.code).toBe("INVALID_INPUT");
      expect(isAppError(error) && error.errorId).toBe("agent-private");
      expect(await activeMemberIds(db, team.id)).toEqual(before);
    } finally {
      await teardown(db, workspace.id, [creator.id, ada.id, outsider.id]);
    }
  },
);
