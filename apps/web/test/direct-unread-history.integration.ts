import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

test("an unread history read lists what others wrote and moves the read position over the Agent's own messages", async () => {
  const connectionString = Bun.env.THREAD_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("THREAD_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `u${id.slice(0, 8)}`;
  const user = await db.user.create({ data: { displayName: username, username } });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Unread test", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "unread",
        displayName: "Unread",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const opened = await repo.openForUser(workspace.id, user.id, agent.id);
    const dm = `@${username}`;
    const fromUser = (body: string) =>
      repo.sendMessage(opened.conversationId, opened.senderMemberId, user.id, body);
    // Opening with the Agent's own message must not leave a gap before the first listed one.
    await repo.sendAgentMessage(opened.conversationId, agent.id, "opening");
    const first = await fromUser("one");
    const own = await repo.sendAgentMessage(opened.conversationId, agent.id, "mine");
    const last = await fromUser("three");

    const page = await repo.readMessagesPage(workspace.id, agent.id, dm, {
      unread: true,
      limit: 3,
    });
    expect(page.messages.map((message) => message.sequence)).toEqual([first.sequence]);
    expect(page.unreadCursorBefore).toBe(0);
    expect(page.readPositionAfter).toBe(own.sequence);
    expect(page.moreUnread).toBe(true);

    const rest = await repo.readMessagesPage(workspace.id, agent.id, dm, { unread: true });
    expect(rest.messages.map((message) => message.sequence)).toEqual([last.sequence]);
    expect(rest.unreadCursorBefore).toBe(own.sequence);
    expect(rest.readPositionAfter).toBe(last.sequence);
    expect(rest.moreUnread).toBe(false);
  } finally {
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
