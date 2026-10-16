import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PublicChannels,
  channelAgentRecipients,
} from "#src/server/conversations/public-channels.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { unreadAgentMessagesFragment } from "#src/server/db/repositories/agent-attention.repositories.server";

test("Memory observes undirected and Task-directed updates and reads the full increment once", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const owner = await db.user.create({
    data: { username: `memory-observer-${suffix}`, displayName: "Memory observer owner" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Memory observation",
      members: { create: { userId: owner.id } },
      memoryProfile: { create: { desired: "openviking", observed: "ready" } },
    },
  });
  try {
    const memory = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: "memory",
        displayName: "Memory",
        runtimeConfig: {},
      },
    });
    const task = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: "task",
        displayName: "Task",
        runtimeConfig: {},
      },
    });
    await db.workspaceMemoryAgent.create({
      data: { workspaceId: workspace.id, agentId: memory.id },
    });
    const room = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: "team",
      },
    });
    await db.conversationMember.createMany({
      data: [
        { conversationId: room.id, workspaceId: workspace.id, userId: owner.id },
        {
          conversationId: room.id,
          workspaceId: workspace.id,
          agentId: memory.id,
          channelMuted: true,
        },
        {
          conversationId: room.id,
          workspaceId: workspace.id,
          agentId: task.id,
          channelMuted: true,
        },
      ],
    });
    const channels = new PublicChannels(db, undefined, {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const send = (body: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId: owner.id,
        channelId: room.id,
        idempotencyKey: crypto.randomUUID(),
        body,
      });
    const first = await send("The date means the formal public opening.");
    const second = await send("@task check the new constraint.");
    const deliveries = await db.agentMessageDelivery.findMany({
      where: { agentId: memory.id, conversationId: room.id },
      orderBy: { sequence: "asc" },
    });
    expect(deliveries.map((d) => d.messageId)).toEqual([first.id, second.id]);
    const unreadCount = async () =>
      (
        await db.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM (${unreadAgentMessagesFragment(workspace.id, memory.id)}) unread
      WHERE "conversationId" = ${room.id}::uuid`
      )[0]!.count;
    expect(await unreadCount()).toBe(2);
    const repository = new PrismaDirectConversationRepository(db);
    const read = () => repository.readMessagesPage(workspace.id, memory.id, "#team", { limit: 1 });
    const page1 = await read();
    expect(page1.messages.map((m) => m.id)).toEqual([first.id]);
    expect(page1.hasNewer).toBe(true);
    const page2 = await read();
    expect(page2.messages.map((m) => m.id)).toEqual([second.id]);
    expect((await read()).messages).toEqual([]);
    expect(await unreadCount()).toBe(0);
    const recipients = await db.$transaction((tx) =>
      channelAgentRecipients(tx, {
        conversationId: room.id,
        threadRootId: undefined,
        mentions: [],
        senderAgentId: memory.id,
      }),
    );
    expect(recipients).not.toContain(memory.id);
    await db.workspaceMemoryProfile.update({
      where: { workspaceId: workspace.id },
      data: { desired: "off" },
    });
    const disabled = await send("@task only Task should receive this after memory is disabled.");
    expect(
      await db.agentMessageDelivery.count({
        where: { agentId: memory.id, messageId: disabled.id },
      }),
    ).toBe(0);
    await db.workspaceMemoryProfile.update({
      where: { workspaceId: workspace.id },
      data: { desired: "openviking" },
    });
    await db.agent.update({ where: { id: memory.id }, data: { stoppedAt: new Date() } });
    const stopped = await send("@task Memory is stopped.");
    expect(
      await db.agentMessageDelivery.count({ where: { agentId: memory.id, messageId: stopped.id } }),
    ).toBe(0);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: owner.id } });
    await db.$disconnect();
  }
});
