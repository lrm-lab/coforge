import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { pendingMentionActionsForActor } from "#src/server/conversations/pending-mention-actions.server";

/**
 * `mention pending --limit` reads one page of the sender's pending actions, oldest first, and the
 * route asks for one row more than the page to learn whether another page exists.
 */
test("a limit returns the oldest pending actions first and leaves the rest unread", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const targetCount = 120;
  try {
    const owner = await db.user.create({
      data: { username: `pend-${suffix}`, displayName: "Owner" },
    });
    const workspace = await db.workspace.create({
      data: { slug: `pend-${suffix}`, name: "Pending" },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: owner.id, role: "owner" },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: `pend-${suffix.slice(0, 8)}`,
        displayName: "Pending",
        runtimeConfig: {},
      },
    });
    const channel = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `pend-${suffix.slice(0, 8)}` },
    });
    const sender = await db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, agentId: agent.id },
    });
    const targets = await db.user.createManyAndReturn({
      data: Array.from({ length: targetCount }, (_, index) => ({
        username: `t${index}-${suffix.slice(0, 8)}`,
        displayName: `T${index}`,
      })),
    });
    // One message per target, each a minute after the one before.
    const start = Date.now() - targetCount * 60_000;
    await db.message.createMany({
      data: targets.map((target, index) => ({
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: sender.id,
        body: `@${target.username} hello`,
        sequence: index + 1,
        createdAt: new Date(start + index * 60_000),
      })),
    });
    const messages = await db.message.findMany({
      where: { conversationId: channel.id },
      orderBy: { sequence: "asc" },
      select: { id: true, sequence: true },
    });
    await db.pendingMentionAction.createMany({
      data: targets.map((target, index) => ({
        messageId: messages[index]!.id,
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: sender.id,
        targetUserId: target.id,
        targetHandle: target.username,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(start + index * 60_000),
      })),
    });

    const all = await pendingMentionActionsForActor(db, workspace.id, { agentId: agent.id });
    expect(all).toHaveLength(targetCount);
    const started = performance.now();
    const page = await pendingMentionActionsForActor(
      db,
      workspace.id,
      { agentId: agent.id },
      new Date(),
      51,
    );
    const elapsedMs = performance.now() - started;
    console.log(
      `pending mention actions: page of 51 from ${targetCount} in ${elapsedMs.toFixed(1)} ms`,
    );
    expect(page.map((row) => row.resolutionId)).toEqual(
      all.slice(0, 51).map((row) => row.resolutionId),
    );
    expect(page[0]!.targetHandle).toBe(targets[0]!.username);
    expect(page.at(-1)!.targetHandle).toBe(targets[50]!.username);
  } finally {
    await db.$disconnect();
  }
});
