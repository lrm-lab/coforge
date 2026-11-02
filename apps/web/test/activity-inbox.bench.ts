/**
 * Times the Activity inbox's list against a large viewer: 500 joined channels with 30 unread
 * messages each, 100 of them mentioning the viewer, 200 followed threads with 20 replies each,
 * 100 notified mentions, and 20,000 messages in a channel the viewer is not in.
 *
 *   CHANNEL_TEST_DATABASE_URL=postgresql://… bun test/activity-inbox.bench.ts [label]
 *
 * Reads through the app's own pool configuration (JIT off). After one warm-up walk, prints the
 * median of 7 runs for the All view's first page, a walk through every All page, and the Unread and
 * Mentions first pages, as one JSON line. Seeds its own workspace and deletes it.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { databasePoolConfig } from "#src/server/db/pool-config.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";

const CHANNELS = Number(Bun.env.BENCH_CHANNELS ?? 500);
const TOP_LEVEL = Number(Bun.env.BENCH_TOP_LEVEL ?? 40);
const READ_THROUGH = 10;
const MENTIONED_CHANNELS = 100;
const THREADS = 200;
const REPLIES = 20;
const NOTIFIED_MENTIONS = 100;
const NOISE = 20_000;
const RUNS = 7;

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
// The pool the app runs on, with its session options (JIT off): timings are the production ones.
const db = new PrismaClient({ adapter: new PrismaPg(databasePoolConfig(connectionString)) });
const suffix = crypto.randomUUID().slice(0, 8);

/** Runs `;`-separated statements one at a time, on one connection (the temp table lives there). */
async function statements(sql: string) {
  await db.$transaction(
    async (tx) => {
      for (const statement of sql.split(";").map((part) => part.trim()))
        if (statement) await tx.$executeRawUnsafe(statement);
    },
    { timeout: 120_000 },
  );
}

async function seed() {
  const [alice, bob] = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({ data: { username: `bench-${name}-${suffix}`, displayName: name } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `bench-${suffix}`,
      name: "Bench",
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }] },
    },
  });
  const w = workspace.id;
  const a = alice!.id;
  const b = bob!.id;
  await statements(`
    CREATE TEMP TABLE bench_channels AS
    SELECT gen_random_uuid() AS id, g AS n FROM generate_series(1, ${CHANNELS}) g;
    INSERT INTO conversations ("id", "workspaceId", "channelName", "visibility")
    SELECT id, '${w}', 'bench-' || n || '-${suffix}', 'public' FROM bench_channels;
    INSERT INTO conversation_members ("id", "conversationId", "workspaceId", "userId", "readThroughSequence")
    SELECT gen_random_uuid(), id, '${w}', '${a}', ${READ_THROUGH} FROM bench_channels;
    INSERT INTO conversation_members ("id", "conversationId", "workspaceId", "userId")
    SELECT gen_random_uuid(), id, '${w}', '${b}' FROM bench_channels;
    INSERT INTO messages ("id", "conversationId", "workspaceId", "senderMemberId", "body", "sequence", "createdAt")
    SELECT gen_random_uuid(), c.id, '${w}', bm.id, 'message ' || s, s,
      timestamp '2026-01-01' + (c.n * ${TOP_LEVEL} + s) * interval '1 second'
    FROM bench_channels c
    JOIN conversation_members bm ON bm."conversationId" = c.id AND bm."userId" = '${b}'
    CROSS JOIN generate_series(1, ${TOP_LEVEL}) s;
    INSERT INTO messages ("id", "conversationId", "workspaceId", "senderMemberId", "body", "sequence", "createdAt", "threadRootId")
    SELECT gen_random_uuid(), c.id, '${w}', bm.id, 'reply ' || r, ${TOP_LEVEL} + r,
      timestamp '2026-03-01' + (c.n * ${REPLIES} + r) * interval '1 second', root.id
    FROM bench_channels c
    JOIN conversation_members bm ON bm."conversationId" = c.id AND bm."userId" = '${b}'
    JOIN messages root ON root."conversationId" = c.id AND root."sequence" = 1
    CROSS JOIN generate_series(1, ${REPLIES}) r
    WHERE c.n <= ${THREADS};
    INSERT INTO thread_follows ("memberId", "rootMessageId", "conversationId", "workspaceId")
    SELECT am.id, root.id, c.id, '${w}'
    FROM bench_channels c
    JOIN conversation_members am ON am."conversationId" = c.id AND am."userId" = '${a}'
    JOIN messages root ON root."conversationId" = c.id AND root."sequence" = 1
    WHERE c.n <= ${THREADS};
    INSERT INTO message_mentions ("messageId", "memberId", "conversationId", "workspaceId", "kind", "actorId", "handle")
    SELECT m.id, am.id, c.id, '${w}', 'user', '${b}', 'alice'
    FROM bench_channels c
    JOIN conversation_members am ON am."conversationId" = c.id AND am."userId" = '${a}'
    JOIN messages m ON m."conversationId" = c.id AND m."sequence" = ${TOP_LEVEL - 5}
    WHERE c.n <= ${MENTIONED_CHANNELS};
  `);
  // A channel the viewer is not in: the notified mentions come from it, and its noise is what the
  // conversation index prunes.
  const outside = await db.conversation.create({
    data: {
      workspaceId: w,
      channelName: `bench-outside-${suffix}`,
      members: { create: [{ userId: b }] },
    },
    include: { members: true },
  });
  const sender = outside.members[0]!.id;
  await statements(`
    INSERT INTO messages ("id", "conversationId", "workspaceId", "senderMemberId", "body", "sequence", "createdAt")
    SELECT gen_random_uuid(), '${outside.id}', '${w}', '${sender}', 'noise ' || s, s,
      timestamp '2025-01-01' + s * interval '1 second'
    FROM generate_series(1, ${NOISE}) s;
    INSERT INTO pending_mention_actions ("id", "messageId", "conversationId", "workspaceId", "senderMemberId", "targetUserId", "targetHandle", "expiresAt", "notifiedAt")
    SELECT gen_random_uuid(), m.id, '${outside.id}', '${w}', '${sender}', '${a}', 'alice',
      now() + interval '1 day', m."createdAt" + interval '400 days'
    FROM messages m WHERE m."conversationId" = '${outside.id}' AND m."sequence" <= ${NOTIFIED_MENTIONS};
    ANALYZE;
  `);
  return { workspaceId: w, userId: a };
}

async function median(run: () => Promise<unknown>) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  times.sort((x, y) => x - y);
  return Math.round(times[Math.floor(RUNS / 2)]! * 10) / 10;
}

type Page = Awaited<ReturnType<ActivityInbox["list"]>>;

async function main() {
  const { workspaceId, userId } = await seed();
  try {
    const inbox = new ActivityInbox(db, {});
    const list = (options: Parameters<ActivityInbox["list"]>[2]) =>
      inbox.list(workspaceId, userId, options);
    let pages = 0;
    let items = 0;
    const walk = async () => {
      pages = 0;
      items = 0;
      let cursor: Page["nextCursor"] | undefined;
      do {
        const page: Page = await list({ filter: "all", ...(cursor && { cursor }) });
        pages += 1;
        items += page.items.length;
        cursor = page.nextCursor;
      } while (cursor);
    };
    // Warm the pool, the plan cache and the freshly seeded tables with one whole walk first.
    await walk();
    const result = {
      label: process.argv[2] ?? "",
      allFirstPageMs: await median(() => list({ filter: "all" })),
      allWalkMs: await median(walk),
      unreadFirstPageMs: await median(() => list({ filter: "unread" })),
      mentionsFirstPageMs: await median(() => list({ filter: "mentions" })),
      pages,
      items,
    };
    console.log(JSON.stringify(result));
  } finally {
    await db.workspace.deleteMany({ where: { slug: `bench-${suffix}` } });
    await db.user.deleteMany({ where: { username: { startsWith: "bench-", endsWith: suffix } } });
    await db.$disconnect();
  }
}

await main();
