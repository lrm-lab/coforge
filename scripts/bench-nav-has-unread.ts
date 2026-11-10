/**
 * Measures the capped Activity nav attention query with 400 channels and about 18,000 messages.
 *
 *   CHANNEL_TEST_DATABASE_URL=postgresql://… bun scripts/bench-nav-has-unread.ts
 *
 * The two cases match the release comparison requested for Activity: no unread items and 100+
 * unread items. Each case reports the median of seven warm runs and cleans up its Workspace.
 */
import { PrismaPg } from "../apps/web/node_modules/@prisma/adapter-pg";
import { PrismaClient } from "../apps/web/src/generated/prisma/client";
import { databasePoolConfig } from "../apps/web/src/server/db/pool-config.server";
import { ActivityInbox } from "../apps/web/src/server/inbox/activity-inbox.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point at local PostgreSQL");

const CHANNELS = Number(Bun.env.BENCH_CHANNELS ?? 400);
const MESSAGES_PER_CHANNEL = Number(Bun.env.BENCH_MESSAGES_PER_CHANNEL ?? 45);
const RUNS = Number(Bun.env.BENCH_RUNS ?? 7);
const db = new PrismaClient({ adapter: new PrismaPg(databasePoolConfig(connectionString)) });
const suffix = crypto.randomUUID().slice(0, 8);

async function median(run: () => Promise<unknown>) {
  const times: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  return Math.round(times[Math.floor(RUNS / 2)]! * 10) / 10;
}

async function main() {
  const [viewer, writer] = await Promise.all(
    ["viewer", "writer"].map((role) =>
      db.user.create({ data: { username: `nav-bench-${role}-${suffix}`, displayName: role } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `nav-bench-${suffix}`,
      name: "Activity nav benchmark",
      members: { create: [{ userId: viewer.id, role: "owner" }, { userId: writer.id }] },
    },
  });
  const conversations = await db.conversation.createManyAndReturn({
    data: Array.from({ length: CHANNELS }, (_, index) => ({
      workspaceId: workspace.id,
      channelName: `nav-bench-${suffix}-${index}`,
    })),
  });
  const members = await db.conversationMember.createManyAndReturn({
    data: conversations.flatMap((conversation) => [
      {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        userId: viewer.id,
        readThroughSequence: MESSAGES_PER_CHANNEL,
      },
      { conversationId: conversation.id, workspaceId: workspace.id, userId: writer.id },
    ]),
  });
  const writerMembers = new Map(
    members
      .filter((member) => member.userId === writer.id)
      .map((member) => [member.conversationId, member.id]),
  );
  const messageBase = Date.now() + 1_000;
  await db.message.createMany({
    data: conversations.flatMap((conversation, conversationIndex) =>
      Array.from({ length: MESSAGES_PER_CHANNEL }, (_, messageIndex) => ({
        conversationId: conversation.id,
        workspaceId: workspace.id,
        senderMemberId: writerMembers.get(conversation.id)!,
        body: `benchmark ${conversationIndex}-${messageIndex}`,
        sequence: messageIndex + 1,
        createdAt: new Date(
          messageBase + (conversationIndex * MESSAGES_PER_CHANNEL + messageIndex) * 1000,
        ),
      })),
    ),
  });
  await db.$executeRaw`ANALYZE`;

  try {
    const inbox = new ActivityInbox(db, {});
    const viewerMembers = conversations.map((conversation) => conversation.id);
    const setUnread = async (count: number) => {
      await db.conversationMember.updateMany({
        where: { workspaceId: workspace.id, userId: viewer.id },
        data: { readThroughSequence: MESSAGES_PER_CHANNEL },
      });
      if (count > 0)
        await db.conversationMember.updateMany({
          where: {
            workspaceId: workspace.id,
            userId: viewer.id,
            conversationId: { in: viewerMembers.slice(0, count) },
          },
          data: { readThroughSequence: 0 },
        });
      await db.$executeRaw`ANALYZE "messages", "conversation_members", "conversations"`;
    };
    const results: Record<string, unknown> = {};
    for (const [label, count] of [
      ["zero", 0],
      ["100-plus", 101],
    ] as const) {
      await setUnread(count);
      await inbox.navAttention(workspace.id, viewer.id);
      const attention = await inbox.navAttention(workspace.id, viewer.id);
      results[label] = {
        medianMs: await median(() => inbox.navAttention(workspace.id, viewer.id)),
        unreadCount: attention.unreadCount,
        keyCount: attention.unreadKeys.length,
      };
    }
    console.log(
      JSON.stringify({ channels: CHANNELS, messages: CHANNELS * MESSAGES_PER_CHANNEL, ...results }),
    );
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [viewer.id, writer.id] } } });
    await db.$disconnect();
  }
}

await main();
