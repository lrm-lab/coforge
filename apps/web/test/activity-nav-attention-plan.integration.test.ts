import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";

/**
 * The Activity nav dot counts a followed thread's unread replies as an index range above the
 * viewer's read cursor for that thread, not by joining every reply of every followed thread and
 * discarding the read ones afterwards: the dot is read on every page, and the replies a person
 * has already read only grow. Here the viewer follows 200 threads of 10 read replies each and one
 * with 2 unread; the dot's read runs once to record its SQL, which is then executed under
 * `EXPLAIN ANALYZE` to count the `messages` rows it touched.
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

test.skipIf(!connectionString)(
  "the Activity nav dot reads followed threads' unread replies, not every reply",
  async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
      log: [{ emit: "event", level: "query" }],
    });
    const reads: { query: string; params: unknown[] }[] = [];
    let recording = false;
    db.$on("query", (event) => {
      if (recording && event.query.trimStart().startsWith("SELECT ((")) {
        reads.push({ query: event.query, params: JSON.parse(event.params) });
      }
    });
    const handle = crypto.randomUUID().slice(0, 8);
    const viewer = await db.user.create({ data: { username: `nav-viewer-${handle}` } });
    const writer = await db.user.create({ data: { username: `nav-writer-${handle}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `nav-attention-${handle}`,
        name: "Nav attention",
        members: { create: [{ userId: viewer.id, role: "owner" }, { userId: writer.id }] },
      },
    });
    try {
      const channel = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: `nav-attention-${handle}`,
          members: { create: [{ userId: viewer.id }, { userId: writer.id }] },
        },
        include: { members: true },
      });
      const viewerMember = channel.members.find((member) => member.userId === viewer.id)!;
      const writerMember = channel.members.find((member) => member.userId === writer.id)!;
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
      await db.$executeRaw`ANALYZE messages, thread_follows, thread_reads, conversation_members`;

      recording = true;
      const attention = await new ActivityInbox(db).navAttention(workspace.id, viewer.id);
      recording = false;
      expect(attention).toEqual({ unread: 2 });
      expect(reads).toHaveLength(1);

      let touched = 0;
      for (const { query, params } of reads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
        for (const node of planNodes(plan[0].Plan))
          if (node["Relation Name"] === "messages") touched += rowsTouched(node);
      }
      // About one newest-reply probe per thread and the two unread replies: well below the 2,010
      // replies the viewer follows.
      expect(touched).toBeLessThan(800);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { id: { in: [viewer.id, writer.id] } } });
      await db.$disconnect();
    }
  },
  60_000,
);
