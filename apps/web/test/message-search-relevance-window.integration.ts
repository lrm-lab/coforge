import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { searchMessages } from "#src/server/conversations/message-search.server";
import { MESSAGE_SEARCH_RELEVANCE_WINDOW } from "#src/server/db/repositories/message-search.repositories.server";

/**
 * Relevance ranks `pg_trgm` scores, ~0.2ms per candidate row, so `findMessageSearchIds` scores
 * only the newest `MESSAGE_SEARCH_RELEVANCE_WINDOW` matches: a common term in a large
 * conversation must not turn one search into a multi-second scan (production measured ~400ms
 * before the bound). A query with fewer matches ranks exactly as before; past the window the
 * oldest matches are not candidates at all, even a perfectly relevant one.
 */
test("relevance ranks only the newest matches up to the window", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const slug = `search-window-${suffix}`;
  const username = `search-window-${suffix}`;
  try {
    const user = await db.user.create({ data: { username, displayName: "Window" } });
    const workspace = await db.workspace.create({ data: { slug, name: "Search window" } });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "member" },
    });
    const channel = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "general" },
    });
    const member = await db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, userId: user.id },
    });

    // One more match than the window: the oldest is the most relevant body there is, and still
    // must not appear — the window keeps the newest matches, not the best-scoring ones overall.
    const total = MESSAGE_SEARCH_RELEVANCE_WINDOW + 1;
    const oldestMinute = Date.now() - total * 60_000;
    await db.message.createMany({
      data: Array.from({ length: total }, (_, index) => ({
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: member.id,
        body:
          index === 0
            ? "needle"
            : `filler body with unrelated words ${"padding ".repeat(8)} needle ${index}`,
        sequence: index + 1,
        createdAt: new Date(oldestMinute + index * 60_000),
      })),
    });
    const oldest = await db.message.findFirstOrThrow({
      where: { conversationId: channel.id, sequence: 1 },
      select: { id: true },
    });

    const page = await searchMessages(db, {
      workspaceId: workspace.id,
      userId: user.id,
      query: "needle",
      sort: "relevance",
      limit: total,
      offset: 0,
    });
    const ids = page.results.map((hit) => hit.message.id);
    expect(ids).toHaveLength(MESSAGE_SEARCH_RELEVANCE_WINDOW);
    expect(ids).not.toContain(oldest.id);

    // Paging stops at the window: the match beyond it is never a candidate, so a page past the
    // window is empty rather than reaching older history.
    const past = await searchMessages(db, {
      workspaceId: workspace.id,
      userId: user.id,
      query: "needle",
      sort: "relevance",
      limit: 20,
      offset: MESSAGE_SEARCH_RELEVANCE_WINDOW,
    });
    expect(past.results).toEqual([]);
    expect(past.hasMore).toBe(false);
  } finally {
    await db.workspace.deleteMany({ where: { slug } });
    await db.user.deleteMany({ where: { username } });
    await db.$disconnect();
  }
});
