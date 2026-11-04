import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { navHasUnreadSql } from "#src/server/inbox/activity-inbox-items-sql.server";
import { taskHasUnreadSql } from "#src/server/inbox/activity-inbox-task-items.server";

/**
 * Measures `navHasUnread` (the one EXISTS a read now runs to refresh the Activity dot, task #496)
 * on a seeded dataset: a Workspace with hundreds of channels and threads and 10k+ messages, the
 * viewer joined to all with random read cursors. Prints `EXPLAIN ANALYZE` and the p50/p95 of the
 * query itself. Needs a local PostgreSQL in DATABASE_URL.
 *   usage: DATABASE_URL=... bun apps/web/scripts/bench-nav-has-unread.ts
 */

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const CHANNELS = 400;
const THREADS_PER = 3;
const MSGS_PER_CHANNEL = 30; // 400×30 top-level + 400×3×5 replies = 12000 + 6000 = 18000 messages
const RUNS = 200;

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

async function seed() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const viewer = await db.user.create({
    data: { username: `bench-${suffix}`, displayName: "Bench" },
  });
  const other = await db.user.create({
    data: { username: `bench-o-${suffix}`, displayName: "Other" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `bench-${suffix}`,
      name: "Bench",
      members: {
        create: [
          { userId: viewer.id, role: "owner" },
          { userId: other.id, role: "member" },
        ],
      },
    },
  });
  for (let c = 0; c < CHANNELS; c += 1) {
    const conversation = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `bench-${suffix}-${c}`,
        members: {
          create: [{ userId: viewer.id }, { userId: other.id }],
        },
      },
      include: { members: true },
    });
    const viewerMember = conversation.members.find((m) => m.userId === viewer.id)!;
    const otherMember = conversation.members.find((m) => m.userId === other.id)!;
    const roots: { id: string; sequence: number }[] = [];
    let sequence = 0;
    for (let i = 0; i < MSGS_PER_CHANNEL; i += 1) {
      sequence += 1;
      const root = await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          body: `msg ${i}`,
          sequence,
          senderMemberId: otherMember.id,
        },
      });
      if (i < THREADS_PER) roots.push({ id: root.id, sequence });
    }
    // Replies under the first few roots (threads the viewer follows).
    for (const root of roots) {
      for (let r = 0; r < 5; r += 1) {
        sequence += 1;
        await db.message.create({
          data: {
            workspaceId: workspace.id,
            conversationId: conversation.id,
            body: `reply ${r}`,
            sequence,
            threadRootId: root.id,
            senderMemberId: otherMember.id,
          },
        });
      }
      await db.threadFollow
        .create({
          data: {
            memberId: viewerMember.id,
            rootMessageId: root.id,
            workspaceId: workspace.id,
            conversationId: conversation.id,
          },
        })
        .catch(() => {});
      // A random thread read cursor.
      await db.$executeRaw`INSERT INTO "thread_reads"
        ("memberId","conversationId","workspaceId","rootMessageId","readThroughSequence")
        VALUES (${viewerMember.id}::uuid, ${conversation.id}::uuid, ${workspace.id}::uuid, ${root.id}::uuid, ${Math.floor(Math.random() * sequence)})
        ON CONFLICT ("memberId","rootMessageId") DO NOTHING`;
    }
    // A random conversation read cursor.
    await db.conversationMember.update({
      where: { id: viewerMember.id },
      data: { readThroughSequence: Math.floor(Math.random() * sequence) },
    });
  }
  const count = await db.message.count({ where: { workspaceId: workspace.id } });
  return { workspace, viewer, count };
}

const { workspace, viewer, count } = await seed();
try {
  const sql = navHasUnreadSql(workspace.id, viewer.id, taskHasUnreadSql(workspace.id, viewer.id));
  // Warm the plan cache.
  for (let i = 0; i < 5; i += 1) await db.$queryRaw(sql);
  const timings: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    await db.$queryRaw(sql);
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const explain = await db.$queryRaw<{ "QUERY PLAN": string }[]>(
    Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
  );
  console.log(JSON.stringify({ messages: count, channels: CHANNELS, runs: RUNS }));
  console.log(
    JSON.stringify({
      p50_ms: Number(percentile(timings, 50).toFixed(3)),
      p95_ms: Number(percentile(timings, 95).toFixed(3)),
      max_ms: Number(timings.at(-1)!.toFixed(3)),
    }),
  );
  console.log("--- EXPLAIN (ANALYZE, BUFFERS) ---");
  for (const row of explain) console.log(row["QUERY PLAN"]);
} finally {
  await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: viewer.id } }).catch(() => undefined);
  await db.$disconnect();
}
