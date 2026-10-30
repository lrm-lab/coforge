import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { handleAgentMentionPendingGet } from "#src/routes/api/agent/v1/mention-actions_.pending";
import { pendingMentionActionsForActor } from "#src/server/conversations/pending-mention-views.server";

/**
 * `mention pending` fills its page with the pending actions that still allow one, oldest first:
 * 100 old ones that no longer do must not keep the 101st from the page.
 */
test("rows that allow no action do not take a place in the page", async () => {
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

    // The first 100 targets are already members of the channel (nothing left to do for them);
    // the 101st and later can still be notified.
    const joined = targets.slice(0, 100);
    await db.conversationMember.createMany({
      data: joined.map((target) => ({
        conversationId: channel.id,
        workspaceId: workspace.id,
        userId: target.id,
      })),
    });
    await db.workspaceMembership.createMany({
      data: targets.map((target) => ({
        workspaceId: workspace.id,
        userId: target.id,
        role: "member" as const,
      })),
    });

    const started = performance.now();
    const response = await handleAgentMentionPendingGet(
      new Request("https://server.example/api/agent/v1/mention-actions/pending?limit=10"),
      { workspaceId: workspace.id, agentId: agent.id },
      {
        pendingMentionActions: (workspaceId, agentId) =>
          pendingMentionActionsForActor(db, workspaceId, { agentId }),
      },
    );
    const elapsedMs = performance.now() - started;
    console.log(
      `pending mention actions: page from ${targetCount} (100 done) in ${elapsedMs.toFixed(1)} ms`,
    );
    const page = (await response.json()) as {
      hasMore: boolean;
      noLongerActionable: number;
      pendingMentionActions: Array<{ targetHandle: string }>;
    };
    // 100 old rows no longer allow an action; they do not fill the page.
    expect(page.noLongerActionable).toBe(100);
    expect(page.pendingMentionActions.map((row) => row.targetHandle)).toEqual(
      targets.slice(100, 110).map((target) => target.username),
    );
    expect(page.hasMore).toBe(true);
  } finally {
    await db.$disconnect();
  }
});
