import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PROJECT_DETAIL_SELECT,
  readProjectChannelActivity,
} from "#src/server/projects/project-detail.server";

if (!Bun.env.CHANNEL_TEST_DATABASE_URL)
  throw new Error("CHANNEL_TEST_DATABASE_URL must target disposable local PostgreSQL");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Bun.env.CHANNEL_TEST_DATABASE_URL }),
  log: [{ emit: "event", level: "query" }],
});
const reads: { query: string; params: unknown[] }[] = [];
let recording = false;
db.$on("query", (event) => {
  if (recording && event.query.trimStart().startsWith("SELECT"))
    reads.push({ query: event.query, params: JSON.parse(event.params) });
});
afterAll(() => db.$disconnect());

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

// Prisma validates a query's shape against the migrated schema before it reads a row, so an empty
// result is enough to prove the select names only fields that exist. A field dropped from the
// schema but still selected made every project page fail (`Unknown field` on `User`).
test("the project page's query is valid for the migrated schema", async () => {
  const project = await db.project.findFirst({
    where: { workspaceId: crypto.randomUUID(), slug: "no-such-project" },
    select: PROJECT_DETAIL_SELECT,
  });
  expect(project).toBeNull();
});

/**
 * The project page counts each of its channels' members and messages and shows the newest
 * message. A relation `_count` grouped every message and member row in the database before
 * joining them to the project's channels, and a `take: 1` relation read every message of those
 * channels. Here a channel outside the project holds 20,000 messages; each read the page issues
 * runs once to record its SQL, which is then executed under `EXPLAIN ANALYZE` to count the
 * `messages` and `conversation_members` rows it touched.
 */
test("the project page reads only its own channels' rows", async () => {
  const handle = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `project-owner-${handle}`, username: `project-owner-${handle}` },
  });
  const left = await db.user.create({
    data: { displayName: `project-left-${handle}`, username: `project-left-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `project-detail-${handle}`,
      name: "Project detail",
      members: { create: [{ userId: owner.id, role: "owner" }, { userId: left.id }] },
    },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: `helper-${handle}`,
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const project = await db.project.create({
      data: { workspaceId: workspace.id, name: "Project", slug: `project-${handle}` },
    });
    const channel = (name: string, projectId: string | null) =>
      db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: `${name}-${handle}`,
          projectId,
          members: {
            create: [
              { userId: owner.id },
              { userId: left.id, leftAt: new Date() },
              { agentId: agent.id },
            ],
          },
        },
        include: { members: true },
      });
    const busy = await channel("busy", project.id);
    const quiet = await channel("quiet", project.id);
    const empty = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `empty-${handle}`, projectId: project.id },
    });
    const elsewhere = await channel("elsewhere", null);
    const post = (
      conversation: typeof busy,
      from: number,
      through: number,
      senderMemberId: string,
    ) => db.$executeRaw`
      INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence,
        "createdAt")
      SELECT gen_random_uuid(), ${conversation.id}::uuid, ${workspace.id}::uuid,
        ${senderMemberId}::uuid, 'message ' || n, n,
        now() - interval '1 day' + n * interval '1 second'
      FROM generate_series(${from}::int, ${through}::int) AS n`;
    const memberOf = (conversation: typeof busy, match: { userId?: string; agentId?: string }) =>
      conversation.members.find(
        (member) =>
          (match.userId && member.userId === match.userId) ||
          (match.agentId && member.agentId === match.agentId),
      )!.id;
    await post(busy, 1, 30, memberOf(busy, { userId: owner.id }));
    await post(busy, 31, 31, memberOf(busy, { agentId: agent.id }));
    await post(quiet, 1, 4, memberOf(quiet, { userId: owner.id }));
    await post(elsewhere, 1, 20_000, memberOf(elsewhere, { agentId: agent.id }));
    await db.$executeRaw`ANALYZE messages, conversation_members`;

    recording = true;
    const detail = await db.project.findFirstOrThrow({
      where: { workspaceId: workspace.id, slug: project.slug },
      select: PROJECT_DETAIL_SELECT,
    });
    const activity = await readProjectChannelActivity(
      db,
      detail.conversations.map((conversation) => conversation.id),
    );
    recording = false;

    expect(detail.conversations.map((conversation) => conversation.id)).toEqual([
      busy.id,
      quiet.id,
      empty.id,
    ]);
    const summary = (id: string) => {
      const { memberCount, messageCount, lastMessage } = activity.get(id)!;
      return {
        memberCount,
        messageCount,
        sender: lastMessage?.sender?.agent?.displayName ?? lastMessage?.sender?.user?.username,
      };
    };
    // Who is in the channel now excludes the member who left it.
    expect(summary(busy.id)).toEqual({ memberCount: 2, messageCount: 31, sender: "Helper" });
    expect(summary(quiet.id)).toEqual({
      memberCount: 2,
      messageCount: 4,
      sender: owner.username,
    });
    expect(summary(empty.id)).toEqual({ memberCount: 0, messageCount: 0, sender: undefined });

    const touched = { messages: 0, conversation_members: 0 };
    for (const { query, params } of reads) {
      const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
        [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
      >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
      for (const node of planNodes(plan[0].Plan)) {
        const relation = node["Relation Name"];
        if (relation === "messages" || relation === "conversation_members")
          touched[relation] += rowsTouched(node);
      }
    }
    // The project's 35 messages counted once and the newest of each channel read: far below the
    // 20,000 of the channel outside the project.
    expect(touched.messages).toBeLessThan(200);
    expect(touched.conversation_members).toBeLessThan(50);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, left.id] } } });
  }
}, 60_000);
