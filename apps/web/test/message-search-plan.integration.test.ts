import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  findMessageSearchIds,
  type MessageSearchCriteria,
} from "#src/server/db/repositories/message-search.repositories.server";

/**
 * A message search with filters but no text reads the Workspace's messages through an index and
 * the unfiltered case reads newest first from the recency index, instead of scanning every
 * message and sorting them. The query is planned against the migrated schema with sequential
 * scans disabled. The fixture creates enough messages in one Workspace and runs ANALYZE so the
 * plan reflects the production-sized cardinality instead of the empty random Workspace this test
 * used to query.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `agent-deletion.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type PlanNode = { "Node Type": string; "Index Name"?: string; Plans?: PlanNode[] };

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

test.skipIf(!connectionString)(
  "a filter-only message search reads the Workspace's messages newest first from an index",
  { timeout: 30_000 },
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { username: `message-search-plan-${suffix}`, displayName: "Message search plan" },
    });
    const workspace = await db.workspace.create({
      data: { slug: `message-search-plan-${suffix}`, name: "Message search plan" },
    });
    const otherUsers = await db.user.createManyAndReturn({
      data: Array.from({ length: 99 }, (_, index) => ({
        username: `message-search-plan-${suffix}-${index}`,
        displayName: "Message search plan",
      })),
    });
    const users = [user, ...otherUsers];
    await db.workspaceMembership.createMany({
      data: users.map((member, index) => ({
        workspaceId: workspace.id,
        userId: member.id,
        role: index === 0 ? ("owner" as const) : ("member" as const),
      })),
    });
    const conversations = await db.conversation.createManyAndReturn({
      data: Array.from({ length: 100 }, (_, index) => ({
        workspaceId: workspace.id,
        channelName: `message-search-plan-${suffix}-${index}`,
      })),
    });
    const members = await db.conversationMember.createManyAndReturn({
      data: conversations.flatMap((conversation) =>
        users.map((member) => ({
          conversationId: conversation.id,
          workspaceId: workspace.id,
          userId: member.id,
        })),
      ),
    });
    const memberByConversationAndUser = new Map(
      members.map((member) => [`${member.conversationId}:${member.userId}`, member.id]),
    );
    const now = Date.now();
    await db.message.createMany({
      data: Array.from({ length: 100_000 }, (_, index) => ({
        conversationId: conversations[index % conversations.length]!.id,
        workspaceId: workspace.id,
        senderMemberId: memberByConversationAndUser.get(
          `${conversations[index % conversations.length]!.id}:${users[index % users.length]!.id}`,
        )!,
        body: `message ${index}`,
        sequence: index + 1,
        createdAt: new Date(now - (100_000 - index) * 1_000),
      })),
    });
    try {
      // Keep planner statistics representative of a production-sized Workspace. Without this,
      // an empty random Workspace lets PostgreSQL choose an unrelated index by cost alone.
      await db.$executeRaw`ANALYZE "messages"`;
      await db.$executeRaw`ANALYZE "conversations"`;
      await db.$executeRaw`ANALYZE "conversation_members"`;
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        const indexes = await tx.$queryRaw<{ indexname: string; indexdef: string }[]>`
          SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'messages' AND indexname = 'messages_workspaceId_createdAt_id_idx'
        `;
        expect(indexes).toHaveLength(1);
        expect(indexes[0]!.indexdef).toContain('("workspaceId", "createdAt" DESC, id DESC)');
        // Plans the search's own query instead of running it, and keeps the plan.
        let plan: [{ Plan: PlanNode }] | undefined;
        const explain = {
          $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            [{ "QUERY PLAN": plan }] = await tx.$queryRaw<[{ "QUERY PLAN": [{ Plan: PlanNode }] }]>`
              EXPLAIN (FORMAT JSON) ${Prisma.sql(strings, ...values)}`;
            return [];
          },
        } as unknown as PrismaClient;
        for (const filters of [
          {},
          { senderKind: "agent" as const },
          { senderId: crypto.randomUUID() },
          { mentionsViewer: true },
        ] satisfies Pick<MessageSearchCriteria, "senderId" | "senderKind" | "mentionsViewer">[]) {
          await findMessageSearchIds(explain, {
            workspaceId: workspace.id,
            viewerUserId: user.id,
            terms: [],
            query: "",
            before: new Date(),
            sort: "recent",
            limit: 20,
            offset: 40,
            ...filters,
          });
          const nodes = planNodes(plan![0].Plan);
          const nodeTypes = nodes.map((node) => node["Node Type"]);
          // Filter-specific indexes may be cheaper than the recency index, but every variant must
          // stay index-backed and avoid a full Workspace scan. The unfiltered query is the
          // ordering-critical path and must use the recency index without an explicit sort.
          expect(nodeTypes).not.toContain("Seq Scan");
          expect(nodeTypes.some((type) => type?.includes("Index"))).toBe(true);
          if (Object.keys(filters).length === 0) {
            expect(nodes.map((node) => node["Index Name"])).toContain(
              "messages_workspaceId_createdAt_id_idx",
            );
            expect(nodeTypes).not.toContain("Sort");
          }
        }
      });
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: { in: users.map((member) => member.id) } } });
      await db.$disconnect();
    }
  },
);

/**
 * A relevance search scores every candidate with `pg_trgm`, which costs ~0.2ms per row: an
 * unbounded rank over a common term in a large conversation took ~400ms on production. The
 * query therefore ranks only a bounded pool — the newest `MESSAGE_SEARCH_RELEVANCE_WINDOW`
 * matches plus any whole-phrase hits — so its plan carries a `Limit` for the window bound on
 * top of the page's own `Limit`, where an unbounded rank has only the page's.
 */
test.skipIf(!connectionString)(
  "a relevance message search ranks a bounded pool of matches",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        // Plans each of the search's own queries instead of running them: relevance pages the
        // ranked pool first, then the match tail, so the first plan is the one that must read
        // candidates through the bounded subquery.
        const plans: { Plan: PlanNode }[][] = [];
        const explain = {
          $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const rows = await tx.$queryRaw<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>`
              EXPLAIN (FORMAT JSON) ${Prisma.sql(strings, ...values)}`;
            plans.push(rows[0]!["QUERY PLAN"]);
            return [];
          },
        } as unknown as PrismaClient;
        await findMessageSearchIds(explain, {
          workspaceId: crypto.randomUUID(),
          viewerUserId: crypto.randomUUID(),
          terms: ["needle"],
          query: "needle",
          sort: "relevance",
          limit: 20,
          offset: 0,
        });
        const nodes = planNodes(plans[0]![0].Plan);
        const limits = nodes.filter((node) => node["Node Type"] === "Limit");
        expect(limits.length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      await db.$disconnect();
    }
  },
);
