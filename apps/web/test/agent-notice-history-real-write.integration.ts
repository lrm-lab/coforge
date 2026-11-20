import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WEB_DRAFT_REVIEW_MARKER } from "#src/server/artifacts/artifact-notice-visibility.server";
import { PrismaSystemAgentEventStore } from "#src/server/db/repositories/system-agent-event.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");

test("a notice written through the system store reads back only while its artifact is readable", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `written-${suffix}`, username: `written${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `written-${suffix}`,
      name: "Written notices",
      members: { create: [{ userId: user.id }] },
    },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "reader",
        displayName: "Reader",
        runtimeConfig: {},
      },
      select: { id: true },
    });
    const artifact = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        homeKey: "workspace",
        access: "workspace",
        name: `written-${suffix}`,
        entryPath: "index.html",
      },
      select: { id: true },
    });
    const store = new PrismaSystemAgentEventStore(db);
    const expiresAt = await store.expiryAfter(604_800);
    const write = (artifactId: string, body: string) =>
      store.write({
        source: "system.artifacts",
        workspaceId: workspace.id,
        agentId: agent.id,
        externalEventId: `${artifactId}:${WEB_DRAFT_REVIEW_MARKER}:${crypto.randomUUID()}`,
        expiresAt,
        body,
      });
    const blocked = await write(crypto.randomUUID(), "blocked notice");
    const first = await write(artifact.id, "first readable notice");
    const second = await write(artifact.id, "second readable notice");
    if (!blocked || !first || !second) throw new Error("an event was not written");

    const messages = new PrismaDirectConversationRepository(db);
    const read = () =>
      messages.readMessagesPage(workspace.id, agent.id, "@app.system.artifacts", {
        unread: true,
        limit: 1,
      });
    const storedPosition = async () =>
      (
        await db.conversationMember.findUniqueOrThrow({
          where: {
            conversationId_agentId: { conversationId: first.conversationId, agentId: agent.id },
          },
          select: { agentReadThroughSequence: true },
        })
      ).agentReadThroughSequence;

    expect(await storedPosition()).toBe(0);
    const firstPage = await read();
    expect(firstPage.messages.map((message) => message.id)).toEqual([first.messageId]);
    expect(firstPage.moreUnread).toBe(true);
    expect(firstPage.readPositionAfter).toBe(first.sequence);
    expect(await storedPosition()).toBe(first.sequence);
    const secondPage = await read();
    expect(secondPage.messages.map((message) => message.id)).toEqual([second.messageId]);
    expect(secondPage.moreUnread).toBe(false);
    expect(secondPage.readPositionAfter).toBe(second.sequence);
    expect(await storedPosition()).toBe(second.sequence);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
