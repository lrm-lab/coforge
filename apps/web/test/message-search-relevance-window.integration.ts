import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { searchMessages } from "#src/server/conversations/message-search.server";
import { MESSAGE_SEARCH_RELEVANCE_WINDOW } from "#src/server/db/repositories/message-search.repositories.server";

/**
 * Relevance ranks `pg_trgm` scores, ~0.2ms per candidate row, so `findMessageSearchIds` scores
 * only a bounded pool: the newest `MESSAGE_SEARCH_RELEVANCE_WINDOW` matches plus every match
 * containing the whole query as one phrase (usually few, served by the trigram index). Past the
 * pool the remaining matches continue in `createdAt` order, so paging never dead-ends: an old
 * message is always reachable, and a remembered phrase is found wherever it lives.
 */
const WINDOW = MESSAGE_SEARCH_RELEVANCE_WINDOW;

test("relevance surfaces phrase matches beyond the window and pages the rest in time order", async () => {
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

    // WINDOW + 60 matches for "alpha beta": the oldest holds the phrase verbatim, the next 59
    // carry both terms scattered (match, but not the phrase), the newest WINDOW are windowed.
    const total = WINDOW + 60;
    const oldestMinute = Date.now() - total * 60_000;
    const bodies = Array.from({ length: total }, (_, index) => {
      if (index === 0) return "alpha beta";
      if (index <= 59) return `alpha notes ${index} then later beta ${"padding ".repeat(8)}`;
      return `alpha filler ${index} beta ${"padding ".repeat(8)}`;
    });
    await db.message.createMany({
      data: bodies.map((body, index) => ({
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: member.id,
        body,
        sequence: index + 1,
        createdAt: new Date(oldestMinute + index * 60_000),
      })),
    });
    const bySequence = async (sequence: number) =>
      (
        await db.message.findFirstOrThrow({
          where: { conversationId: channel.id, sequence },
          select: { id: true },
        })
      ).id;
    const verbatimId = await bySequence(1);
    const tailIds = await Promise.all(
      Array.from({ length: 59 }, (_, index) => bySequence(index + 2)),
    );

    const search = (input: { limit: number; offset: number; query?: string }) =>
      searchMessages(db, {
        workspaceId: workspace.id,
        userId: user.id,
        query: input.query ?? "alpha beta",
        sort: "relevance",
        limit: input.limit,
        offset: input.offset,
      });

    // The verbatim hit is beyond the window yet ranks first: an exact phrase is the strongest
    // match there is. Every match is reachable — the 59 scattered old ones follow in time order.
    const all = await search({ limit: total, offset: 0 });
    const allIds = all.results.map((hit) => hit.message.id);
    expect(allIds).toHaveLength(total);
    expect(all.hasMore).toBe(false);
    expect(allIds[0]).toBe(verbatimId);
    // Positions WINDOW + 1 .. end are the tail: newest tail row first, down to the oldest.
    expect(allIds.slice(WINDOW + 1)).toEqual([...tailIds].reverse());

    // A page straddling the pool boundary mixes ranked rows then tail rows, and reports more.
    const straddle = await search({ limit: 20, offset: WINDOW - 10 });
    const straddleIds = straddle.results.map((hit) => hit.message.id);
    expect(straddleIds).toHaveLength(20);
    expect(straddle.hasMore).toBe(true);
    // 11 ranked rows (pool positions WINDOW-10 .. WINDOW), then tail from its newest.
    expect(straddleIds[11]).toBe(tailIds[58]);

    // A deep page lands entirely in the tail, offset past the pool, newest tail first.
    const deep = await search({ limit: 20, offset: total - 20 });
    const deepIds = deep.results.map((hit) => hit.message.id);
    expect(deepIds).toEqual(tailIds.slice(0, 20).reverse());
    expect(deep.hasMore).toBe(false);
  } finally {
    await db.workspace.deleteMany({ where: { slug } });
    await db.user.deleteMany({ where: { username } });
    await db.$disconnect();
  }
});

test("a single-term relevance search keeps the window but still pages older matches", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const slug = `search-window-single-${suffix}`;
  const username = `search-window-single-${suffix}`;
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

    // One term matches every row, so "verbatim" would be all of them: the ranked pool stays the
    // newest WINDOW and the older matches continue in the tail instead of being boosted.
    const total = WINDOW + 1;
    const oldestMinute = Date.now() - total * 60_000;
    await db.message.createMany({
      data: Array.from({ length: total }, (_, index) => ({
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: member.id,
        body: index === 0 ? "alpha" : `alpha filler ${index} ${"padding ".repeat(8)}`,
        sequence: index + 1,
        createdAt: new Date(oldestMinute + index * 60_000),
      })),
    });
    const oldest = await db.message.findFirstOrThrow({
      where: { conversationId: channel.id, sequence: 1 },
      select: { id: true },
    });

    const search = (input: { limit: number; offset: number }) =>
      searchMessages(db, {
        workspaceId: workspace.id,
        userId: user.id,
        query: "alpha",
        sort: "relevance",
        limit: input.limit,
        offset: input.offset,
      });

    const first = await search({ limit: WINDOW, offset: 0 });
    const firstIds = first.results.map((hit) => hit.message.id);
    expect(firstIds).toHaveLength(WINDOW);
    expect(first.hasMore).toBe(true);
    expect(firstIds).not.toContain(oldest.id);

    // The page past the window is the tail: the single oldest match, in time order.
    const past = await search({ limit: 20, offset: WINDOW });
    expect(past.results.map((hit) => hit.message.id)).toEqual([oldest.id]);
    expect(past.hasMore).toBe(false);
  } finally {
    await db.workspace.deleteMany({ where: { slug } });
    await db.user.deleteMany({ where: { username } });
    await db.$disconnect();
  }
});
