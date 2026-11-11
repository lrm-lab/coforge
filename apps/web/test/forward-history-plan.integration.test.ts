import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { forwardHistory } from "#src/server/conversations/forward-targets.server";

/**
 * The forward picker's "most forwarded" read counts a person's forwards from the
 * `message_forwards (workspaceId, senderUserId, createdAt DESC)` index and stops after the
 * window, instead of walking the Workspace's messages newest first and checking each row's
 * sender — the shape that made a member who never forwarded read every message in the Workspace
 * (task #78). The query is planned against the migrated schema with a production-sized fixture
 * and ANALYZE, as `message-search-plan.integration.test.ts` does.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/** The rows the plan reads of `relation` (a scan node's actual rows, loops included). */
function rowsRead(nodes: PlanNode[], relation: string) {
  return nodes
    .filter((node) => node["Relation Name"] === relation)
    .reduce((sum, node) => sum + (node["Actual Rows"] ?? 0), 0);
}

test.skipIf(!connectionString)(
  "a member's forwards are read from the sender's own index, bounded by the window",
  { timeout: 30_000 },
  async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
      log: [{ emit: "event", level: "query" }],
    });
    const reads: { query: string; params: unknown[] }[] = [];
    db.$on("query", (event) => {
      if (event.query.includes('FROM "public"."message_forwards"'))
        reads.push({ query: event.query, params: JSON.parse(event.params) });
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const users = await Promise.all(
      ["heavy", "other"].map((name) =>
        db.user.create({ data: { username: `forward-plan-${name}-${suffix}`, displayName: name } }),
      ),
    );
    const workspace = await db.workspace.create({
      data: {
        slug: `forward-plan-${suffix}`,
        name: "Forward plan",
        members: { create: users.map((user) => ({ userId: user.id })) },
      },
    });
    const channels = await db.conversation.createManyAndReturn({
      data: Array.from({ length: 2 }, (_, index) => ({
        workspaceId: workspace.id,
        channelName: `forward-plan-${suffix}-${index}`,
      })),
    });
    // 3,000 messages carrying forwards: 2,500 the heavy member made, 500 the other one's.
    const now = Date.now();
    const messages = await db.message.createManyAndReturn({
      data: Array.from({ length: 3_000 }, (_, index) => {
        const channel = channels[index % channels.length]!;
        return {
          workspaceId: workspace.id,
          conversationId: channel.id,
          senderMemberId: null,
          sequence: index + 1,
          body: "",
          createdAt: new Date(now - (3_000 - index) * 1_000),
        };
      }),
      select: { id: true, conversationId: true },
    });
    await db.messageForward.createMany({
      data: messages.map(({ id, conversationId }, index) => ({
        messageId: id,
        position: 0,
        sourceConversationId: conversationId,
        sourceSenderName: "Source",
        sourceSenderHandle: "source",
        sourceCreatedAt: new Date(now),
        sourceBody: "forwarded",
        workspaceId: workspace.id,
        senderUserId: index < 2_500 ? users[0]!.id : users[1]!.id,
      })),
    });
    try {
      await db.$executeRaw`ANALYZE "message_forwards"`;
      await db.$executeRaw`ANALYZE "messages"`;
      // Both members' reads, so the never-forwarded one is planned too.
      await forwardHistory(db, workspace.id, users[1]!.id);
      await forwardHistory(db, workspace.id, users[0]!.id);
      const forwardReads = reads.filter(({ params }) => params[1] !== undefined);
      expect(forwardReads).toHaveLength(2);
      for (const { query, params } of forwardReads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
        const nodes = planNodes(plan[0].Plan);
        const scans = nodes.filter((node) => node["Relation Name"] === "message_forwards");
        expect(scans).toHaveLength(1);
        expect(scans[0]!["Node Type"]).not.toBe("Seq Scan");
        // The window bounds the read: 500 of this fixture's 3,000 forwards, not the Workspace's.
        expect(rowsRead(nodes, "message_forwards")).toBeLessThanOrEqual(500);
      }
      // The read walks the sender's own index, newest first.
      const heavyRead = forwardReads.find(({ params }) => params[1] === users[0]!.id)!;
      const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
        [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
      >(`EXPLAIN (ANALYZE, FORMAT JSON) ${heavyRead.query}`, ...heavyRead.params);
      expect(planNodes(plan[0].Plan).map((node) => node["Index Name"])).toContain(
        "message_forwards_workspaceId_senderUserId_createdAt_idx",
      );
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
      await db.$disconnect();
    }
  },
);
