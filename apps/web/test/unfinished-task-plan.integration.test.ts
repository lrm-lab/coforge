import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * The reads of unfinished Tasks (the Tasks page overview and an Agent's `task list --mine`) find
 * them as an index range over their statuses, instead of reading every Task the Workspace ever
 * finished and discarding it. A Workspace is given a finished history far larger than its open
 * work, as it has once in use; each read runs once to record its SQL, which is then planned.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `message-search-plan.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
/** Ten times the 4 open Tasks, and still two orders of magnitude below the finished history. */
const UNFINISHED_ROW_BUDGET = 40;

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/**
 * Task rows a scan read from the table: the ones it kept plus the ones it discarded afterwards.
 * This, not the plan's shape, is what the reads must keep small. On a database that also holds
 * other Workspaces' Tasks the planner may combine several Task indexes (a BitmapAnd), which is
 * just as cheap.
 */
function taskRowsRead(nodes: PlanNode[]): number {
  return nodes
    .filter((node) => node["Relation Name"] === "tasks")
    .reduce(
      (sum, node) =>
        sum +
        ((node["Actual Rows"] ?? 0) +
          (node["Rows Removed by Filter"] ?? 0) +
          (node["Rows Removed by Index Recheck"] ?? 0)) *
          (node["Actual Loops"] ?? 1),
      0,
    );
}

test.skipIf(!connectionString)(
  "the unfinished Task reads range over the open statuses in a Task index",
  async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
      log: [{ emit: "event", level: "query" }],
    });
    const taskReads: { query: string; params: unknown[] }[] = [];
    db.$on("query", (event) => {
      if (event.query.includes('FROM "public"."tasks"'))
        taskReads.push({ query: event.query, params: JSON.parse(event.params) });
    });
    const handle = crypto.randomUUID().slice(0, 8);
    const user = await db.user.create({
      data: { displayName: `unfinished-plan-${handle}`, username: `unfinished-plan-${handle}` },
    });
    const workspace = await db.workspace.create({
      data: {
        slug: `unfinished-plan-${handle}`,
        name: "Unfinished plan",
        members: { create: [{ userId: user.id, role: "owner" }] },
        agents: {
          create: {
            name: `unfinished-plan-${handle}`,
            displayName: "Plan Agent",
            ownerId: user.id,
            runtimeConfig: {},
          },
        },
      },
      include: { agents: true },
    });
    const agent = workspace.agents[0]!;
    try {
      const channel = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: `unfinished-plan-${handle}`,
          members: { create: [{ userId: user.id }, { agentId: agent.id }] },
        },
        include: { members: true },
      });
      const creator = channel.members.find((member) => member.userId)!;
      const owner = channel.members.find((member) => member.agentId)!;
      // 4,000 finished Tasks and 4 open ones, all owned by the Agent.
      await db.$executeRaw`
        WITH numbered AS (
          INSERT INTO messages (id, "conversationId", "workspaceId", body, sequence)
          SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid, 'task', n
          FROM generate_series(1, 4004) AS n
          RETURNING id, sequence
        )
        INSERT INTO tasks ("messageId", "conversationId", "workspaceId", number, title, status,
          "ownerMemberId", "creatorMemberId", "updatedAt")
        SELECT id, ${channel.id}::uuid, ${workspace.id}::uuid, sequence, 'task',
          CASE WHEN sequence > 4000 THEN 'in_progress' WHEN sequence % 2 = 0 THEN 'done' ELSE 'closed' END,
          ${owner.id}::uuid, ${creator.id}::uuid, now()
        FROM numbered`;
      await db.$executeRaw`ANALYZE tasks`;

      const board = new TaskBoard(db);
      expect((await board.overview(workspace.id, user.id)).tasks).toHaveLength(4);
      const mine = await board.execute(
        { workspaceId: workspace.id, agentId: agent.id },
        { idempotencyKey: crypto.randomUUID(), operation: "list", mine: true },
      );
      expect(mine.tasks).toHaveLength(4);
      const reads = taskReads.filter(({ query }) => query.includes('"public"."tasks"."status"'));
      expect(reads).toHaveLength(2);

      for (const { query, params } of reads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
        const nodes = planNodes(plan[0].Plan);
        const taskScans = nodes.filter((node) => node["Relation Name"] === "tasks");
        expect(taskScans).toHaveLength(1);
        expect(taskScans[0]!["Node Type"]).not.toBe("Seq Scan");
        // The 4 open Tasks, not the 4,000 finished ones. Checked before the index condition so a
        // failure reports the rows read. Known to fail on a database already full of other
        // Workspaces' Tasks: there the `--mine` read BitmapAnds both Task indexes without their
        // `status` column and filters the finished history out of the heap, because the
        // statistics do not know this owner's Tasks are nearly all finished. That costs about 1 ms
        // at this test's extreme 4,000, and the fix (a partial index on open Tasks) is not worth a
        // migration yet.
        expect(taskRowsRead(nodes)).toBeLessThanOrEqual(UNFINISHED_ROW_BUDGET);
        // A bitmap scan carries its index condition on the child Bitmap Index Scan.
        const taskIndexConds = nodes.flatMap((node) =>
          node["Index Name"]?.startsWith("tasks_") ? [node["Index Cond"] ?? ""] : [],
        );
        expect(taskIndexConds.some((cond) => cond.includes("status = ANY"))).toBe(true);
      }
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
