import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";

/**
 * The Activity nav dot reads unread activity as index ranges above the viewer's read cursors and
 * stops at the first unread row: it is read on every Workspace message, and the messages a person
 * has already read only grow. Each test runs the dot once to record its SQL, then executes that SQL
 * under `EXPLAIN ANALYZE` to count the `messages` rows it touched.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `channel-mention-affinity-plan.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type PlanNode = {
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Relation Name"?: string;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/** Rows a plan read from a table: those an access node returned plus those its filter removed. */
function rowsTouched(node: PlanNode) {
  const loops = node["Actual Loops"] ?? 1;
  return ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * loops;
}

/**
 * A viewer and a writer sharing one channel, plus 20,000 top-level messages in a channel the viewer
 * is not in. Without them every message belongs to the one conversation under test, the
 * conversation index prunes nothing, and a sequential scan is the planner's right choice; a shared
 * table is what the dot reads in production.
 */
async function navFixture(name: string) {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString! }),
    log: [{ emit: "event", level: "query" }],
  });
  const reads: { query: string; params: unknown[] }[] = [];
  let recording = false;
  db.$on("query", (event) => {
    if (recording && event.query.trimStart().startsWith("SELECT (EXISTS"))
      reads.push({ query: event.query, params: JSON.parse(event.params) });
  });
  const handle = crypto.randomUUID().slice(0, 8);
  const viewer = await db.user.create({
    data: { displayName: `${name}-viewer-${handle}`, username: `${name}-viewer-${handle}` },
  });
  const writer = await db.user.create({
    data: { displayName: `${name}-writer-${handle}`, username: `${name}-writer-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `${name}-${handle}`,
      name,
      members: { create: [{ userId: viewer.id, role: "owner" }, { userId: writer.id }] },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `${name}-${handle}`,
      members: { create: [{ userId: viewer.id }, { userId: writer.id }] },
    },
    include: { members: true },
  });
  const other = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `${name}-other-${handle}`,
      members: { create: [{ userId: writer.id }] },
    },
    include: { members: true },
  });
  await db.$executeRaw`
    INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence)
    SELECT gen_random_uuid(), ${other.id}::uuid, ${workspace.id}::uuid,
      ${other.members[0]!.id}::uuid, 'elsewhere ' || i, i
    FROM generate_series(1, 20000) AS i`;

  return {
    db,
    workspace,
    channel,
    viewerMember: channel.members.find((member) => member.userId === viewer.id)!,
    writerMember: channel.members.find((member) => member.userId === writer.id)!,
    /** Runs the dot once and counts the `messages` rows its one statement touched. */
    async readDot() {
      await db.$executeRaw`ANALYZE messages, thread_follows, thread_reads, conversation_members`;
      recording = true;
      const attention = await new ActivityInbox(db, {}).navAttention(workspace.id, viewer.id);
      recording = false;
      expect(reads).toHaveLength(1);
      let touched = 0;
      for (const { query, params } of reads.splice(0)) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
        for (const node of planNodes(plan[0].Plan))
          if (node["Relation Name"] === "messages") touched += rowsTouched(node);
      }
      return { attention, touched };
    },
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { id: { in: [viewer.id, writer.id] } } });
      await db.$disconnect();
    },
  };
}

test.skipIf(!connectionString)(
  "the Activity nav dot reads followed threads' unread replies, not every reply",
  async () => {
    const run = await navFixture("nav-threads");
    const { db, workspace, channel, viewerMember, writerMember } = run;
    try {
      // 201 threads of 11 messages: a root at `11i + 1`, then 10 replies. The viewer follows every
      // one and has read every reply but the last two of the last thread.
      await db.$executeRaw`
        WITH roots AS (
          INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence)
          SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid,
            ${writerMember.id}::uuid, 'root ' || i, 11 * i + 1
          FROM generate_series(0, 200) AS i
          RETURNING id, sequence
        ), replies AS (
          INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence,
            "threadRootId")
          SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid,
            ${writerMember.id}::uuid, 'reply', roots.sequence + n, roots.id
          FROM roots, generate_series(1, 10) AS n
        ), follows AS (
          INSERT INTO thread_follows ("memberId", "rootMessageId", "conversationId", "workspaceId")
          SELECT ${viewerMember.id}::uuid, id, ${channel.id}::uuid, ${workspace.id}::uuid FROM roots
        )
        INSERT INTO thread_reads ("memberId", "rootMessageId", "conversationId", "workspaceId",
          "readThroughSequence")
        SELECT ${viewerMember.id}::uuid, id, ${channel.id}::uuid, ${workspace.id}::uuid,
          CASE WHEN sequence = 2201 THEN sequence + 8 ELSE sequence + 10 END
        FROM roots`;
      // Every top-level message is read, so only the two replies are unread.
      await db.conversationMember.update({
        where: { id: viewerMember.id },
        data: { readThroughSequence: 2211 },
      });

      const { attention, touched } = await run.readDot();
      expect(attention).toEqual({ hasUnread: true });
      // About one newest-reply probe per thread and the first unread reply: well below the 2,010
      // replies the viewer follows.
      expect(touched).toBeLessThan(800);
    } finally {
      await run.cleanup();
    }
  },
  60_000,
);

test.skipIf(!connectionString)(
  "the Activity nav dot stops at the first unread message instead of counting them all",
  async () => {
    const run = await navFixture("nav-busy");
    const { db, workspace, channel, writerMember } = run;
    try {
      // 3,000 top-level messages the viewer has never read.
      await db.$executeRaw`
        INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence)
        SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid,
          ${writerMember.id}::uuid, 'unread ' || i, i
        FROM generate_series(1, 3000) AS i`;

      const { attention, touched } = await run.readDot();
      expect(attention).toEqual({ hasUnread: true });
      // The newest-message probe and the first unread one, not all 3,000.
      expect(touched).toBeLessThan(50);
    } finally {
      await run.cleanup();
    }
  },
  60_000,
);
