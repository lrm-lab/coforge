import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { activityPageSql } from "#src/server/inbox/activity-inbox-page-sql.server";

/**
 * A page of the Activity inbox reads each listed item's unread messages only for the items on that
 * page: the list orders and pages its items in the database, and counts unread messages after the
 * page is cut. Every item still costs a newest-message probe, so the rows a page touches grow with
 * the page and the number of items, not with how much is unread in items off the page. The test
 * runs a second page's statement under `EXPLAIN ANALYZE` to count the `messages` rows it touched.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `activity-nav-attention-plan.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const CHANNELS = 15;
const UNREAD_PER_CHANNEL = 300;
const PAGE_SIZE = 3;
const OTHER_CHANNELS = 100;
const MESSAGES_PER_OTHER_CHANNEL = 1_000;

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
  "an Activity page counts unread messages for its own items, not for every item",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const handle = crypto.randomUUID().slice(0, 8);
    const viewer = await db.user.create({
      data: { displayName: `page-viewer-${handle}`, username: `page-viewer-${handle}` },
    });
    const writer = await db.user.create({
      data: { displayName: `page-writer-${handle}`, username: `page-writer-${handle}` },
    });
    const workspace = await db.workspace.create({
      data: {
        slug: `page-plan-${handle}`,
        name: "page-plan",
        members: { create: [{ userId: viewer.id, role: "owner" }, { userId: writer.id }] },
      },
    });
    try {
      // Fifteen joined channels of 300 messages the viewer has never read, each newer than the last.
      for (let index = 0; index < CHANNELS; index += 1) {
        const channel = await db.conversation.create({
          data: {
            workspaceId: workspace.id,
            channelName: `page-${index}-${handle}`,
            members: { create: [{ userId: viewer.id }, { userId: writer.id }] },
          },
          include: { members: true },
        });
        const writerMember = channel.members.find((member) => member.userId === writer.id)!;
        await db.$executeRaw`
          INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence,
            "createdAt")
          SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid,
            ${writerMember.id}::uuid, 'unread ' || i, i,
            timestamp '2026-01-01' + (${index}::int * ${UNREAD_PER_CHANNEL}::int + i) * interval '1 second'
          FROM generate_series(1, ${UNREAD_PER_CHANNEL}::int) AS i`;
      }
      // The rest of a Workspace: 100 channels the viewer is not in, of 1,000 messages each. A
      // table of a few conversations makes a sequential scan cheaper than the conversation index
      // for each page row's count, which no Workspace of any size would see.
      await db.conversation.createMany({
        data: Array.from({ length: OTHER_CHANNELS }, (_, index) => ({
          workspaceId: workspace.id,
          channelName: `page-other-${index}-${handle}`,
        })),
      });
      await db.$executeRaw`
        INSERT INTO messages (id, "conversationId", "workspaceId", body, sequence)
        SELECT gen_random_uuid(), c."id", c."workspaceId", 'elsewhere ' || i, i
        FROM conversations c CROSS JOIN generate_series(1, ${MESSAGES_PER_OTHER_CHANNEL}::int) AS i
        WHERE c."workspaceId" = ${workspace.id}::uuid AND c."channelName" LIKE 'page-other-%'`;
      const inbox = new ActivityInbox(db, {});
      const first = await inbox.list(workspace.id, viewer.id, { filter: "all", limit: PAGE_SIZE });
      expect(first.items).toHaveLength(PAGE_SIZE);
      expect(first.unreadItemCount).toBe(CHANNELS);

      const second = await inbox.list(workspace.id, viewer.id, {
        filter: "all",
        limit: PAGE_SIZE,
        cursor: first.nextCursor!,
      });
      expect(second.items.map((item) => item.unreadCount)).toEqual(
        Array.from({ length: PAGE_SIZE }, () => UNREAD_PER_CHANNEL),
      );
      expect(second.unreadItemCount).toBe(CHANNELS);

      // The second page's statement itself, built as the list builds it and run once more under
      // `EXPLAIN ANALYZE`.
      const statement = activityPageSql(workspace.id, viewer.id, {
        filter: "all",
        limit: PAGE_SIZE,
        cursor: first.nextCursor!,
      });
      // Statistics fresh for every table the statement reads, and kept for the EXPLAIN: ANALYZE
      // holds its lock to the end of the transaction, so no autovacuum rewrites them in between.
      const [{ "QUERY PLAN": plan }] = await db.$transaction(async (tx) => {
        await tx.$executeRaw`ANALYZE messages, conversation_members, conversations,
          conversation_pins, thread_follows, thread_reads, message_mentions,
          pending_mention_actions, attachment_comments, attachments, tasks, task_follows, agents`;
        return tx.$queryRawUnsafe<[{ "QUERY PLAN": [{ Plan: PlanNode }] }]>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
          ...statement.values,
        );
      });
      let touched = 0;
      for (const node of planNodes(plan[0].Plan))
        if (node["Relation Name"] === "messages") touched += rowsTouched(node);
      // The unread messages of the page's items (and the one past it that says there is a next
      // page), 1,200, plus a probe or two per item. Counting every item's unread messages touches
      // all 4,500; half of that leaves the plan room to vary.
      expect(touched).toBeLessThan((CHANNELS * UNREAD_PER_CHANNEL) / 2);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { id: { in: [viewer.id, writer.id] } } });
      await db.$disconnect();
    }
  },
  60_000,
);
