import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { encodeAgentMessageSearchCursor } from "#src/server/db/repositories/agent-message-search-cursor.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * An Agent's `recent` search with a query pages by cursor on a real database: messages that
 * share one `createdAt` are neither repeated nor skipped across pages, the last page has no
 * cursor, and a cursor that was altered is refused.
 */
test("pages a recent search by cursor without repeating or skipping messages that share a time", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  try {
    const user = await db.user.create({
      data: { username: `cursor-${suffix}`, displayName: "Cursor" },
    });
    const workspace = await db.workspace.create({
      data: { slug: `cursor-${suffix}`, name: "Cursor" },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "member" },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: `cursor-${suffix.slice(0, 8)}`,
        displayName: "Cursor",
        runtimeConfig: {},
      },
    });
    const channel = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "general" },
    });
    const human = await db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, userId: user.id },
    });
    await db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, agentId: agent.id },
    });
    // Seven matches: four share one millisecond, the rest are spread around it.
    const tie = new Date("2026-09-07T10:00:00.000Z");
    const times = [-2000, 0, 0, 0, 0, 1000, 2000].map((ms) => new Date(tie.getTime() + ms));
    const created = [];
    for (const [index, createdAt] of times.entries()) {
      created.push(
        await db.message.create({
          data: {
            conversationId: channel.id,
            workspaceId: workspace.id,
            senderMemberId: human.id,
            body: `quarterly zebra report ${index}`,
            sequence: index + 1,
            createdAt,
          },
        }),
      );
    }
    const expected = [...created]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((message) => message.id);

    const repo = new PrismaDirectConversationRepository(db);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await repo.searchMessages(workspace.id, agent.id, {
        query: "zebra",
        sort: "recent",
        limit: 2,
        cursor,
      });
      seen.push(...page.messages.map((message) => message.id));
      pages += 1;
      expect(page.hasMore).toBe(page.nextCursor !== undefined);
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(expected);
    // Seven results in pages of two: the last page holds one and carries no cursor.
    expect(pages).toBe(4);
    expect(cursor).toBeUndefined();

    const first = await repo.searchMessages(workspace.id, agent.id, {
      query: "zebra",
      sort: "recent",
      limit: 2,
    });
    await expect(
      repo.searchMessages(workspace.id, agent.id, {
        query: "zebra",
        sort: "recent",
        cursor: first.nextCursor!.slice(0, -8),
      }),
    ).rejects.toThrow("invalid search cursor");
    await expect(
      repo.searchMessages(workspace.id, agent.id, {
        query: "zebra",
        sort: "recent",
        cursor: encodeAgentMessageSearchCursor({ createdAt: tie, id: "not-a-uuid" }),
      }),
    ).rejects.toThrow("invalid search cursor");
  } finally {
    await db.$disconnect();
  }
});
