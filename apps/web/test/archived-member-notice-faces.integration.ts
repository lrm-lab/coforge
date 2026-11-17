import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AGENT_MASCOTS, agentAvatarUrl } from "#src/features/agents/agent-mascot";
import {
  browserMessageFields,
  mapBrowserMessages,
} from "#src/server/conversations/browser-message-projection.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";

/**
 * Task #93: "Frank removed coforge-qa2 from this channel." drew the removed, archived Agent as a
 * letter on a square, because the faces came from the conversation's current members and a member
 * who has left is not one. The page's message read ships the faces of the people a notice names,
 * from their member rows whether or not they left.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
let userId = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `anf-${suffix}`, displayName: "Frank" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `anf-${suffix}`,
      name: "ANF",
      members: { create: [{ userId, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

test("a notice about a removed, archived Agent carries that Agent's own avatar", async () => {
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `anf-${suffix}`, visibility: "public" },
  });
  // A mascot the Agent's id would not pick by itself, so a match is its own pick, not luck.
  const mascot = AGENT_MASCOTS[AGENT_MASCOTS.length - 1]!;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `anf-gone-${suffix}`,
      displayName: `anf-gone-${suffix}`,
      ownerId: userId,
      runtimeConfig: {},
      avatarMascot: mascot,
      deletedAt: new Date(),
    },
  });
  const [agentMember, frankMember] = await Promise.all([
    db.conversationMember.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        agentId: agent.id,
        leftAt: new Date(),
      },
    }),
    db.conversationMember.create({
      data: { workspaceId, conversationId: channel.id, userId },
    }),
  ]);
  const message = await db.$transaction(async (tx) => {
    const sequence = await allocateSequence(tx, channel.id);
    const created = await tx.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        senderMemberId: null,
        sequence,
        body: `Frank removed @${agent.name} from this channel.`,
      },
    });
    await tx.systemMessage.create({
      data: {
        messageId: created.id,
        conversationId: channel.id,
        workspaceId,
        kind: "channel.member_removed",
        params: {
          members: [
            {
              memberId: agentMember.id,
              handle: agent.name,
              displayName: agent.name,
              kind: "agent",
            },
          ],
          actor: {
            memberId: frankMember.id,
            handle: `anf-${suffix}`,
            displayName: "Frank",
            kind: "user",
          },
        },
      },
    });
    return created;
  });

  const rows = await db.message.findMany({
    where: { id: message.id },
    select: browserMessageFields,
  });
  const [view] = await mapBrowserMessages(db, rows, workspaceId);
  // Two faces, one per person the notice names: the leaver's (an archived Agent's own mascot)
  // and the actor's.
  expect(view!.systemPeople).toEqual({
    [agentMember.id]: {
      kind: "agent",
      id: agent.id,
      avatarUrl: agentAvatarUrl(agent.id, mascot),
    },
    [frankMember.id]: {
      kind: "user",
      id: userId,
      avatarUrl: expect.any(String),
    },
  });
});
