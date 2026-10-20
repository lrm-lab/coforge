import type { getDatabaseClient } from "../src/server/db/client.server";

type SeedDatabase = NonNullable<ReturnType<typeof getDatabaseClient>>;

export type SeedTask = {
  key: string;
  conversationId: string;
  number: number;
  title: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "closed";
  creatorMemberId: string;
  ownerMemberId?: string;
  senderMemberId: string;
  dayOffset: number;
};

/**
 * The seed's Tasks. Each one is a converted message, so `ensureTask` queues its source message
 * with the others, and `insertPendingTasks` writes the Tasks once those messages exist.
 */
export function seedTasks(deps: {
  db: SeedDatabase;
  workspaceId: string;
  stableId: (seed: string) => string;
  ensureMessage: (opts: {
    key: string;
    conversationId: string;
    senderMemberId: string;
    body: string;
    createdAt: Date;
  }) => Promise<string>;
  daysAgo: (days: number, hour?: number) => Date;
}) {
  const { db, workspaceId, stableId } = deps;
  const pendingTasks: Array<SeedTask & { messageId: string }> = [];

  async function ensureTask(opts: SeedTask) {
    const messageId = await deps.ensureMessage({
      key: `task-source:${opts.key}`,
      conversationId: opts.conversationId,
      senderMemberId: opts.senderMemberId,
      body: opts.title,
      createdAt: deps.daysAgo(opts.dayOffset, 17),
    });
    pendingTasks.push({ messageId, ...opts });
  }

  /** Writes the queued Tasks, then moves each conversation's Task counter past the highest number
   * set here by hand, so the first Task sent there does not collide with #1. Never lowers it. */
  async function insertPendingTasks() {
    for (const opts of pendingTasks)
      await db.task.upsert({
        where: { messageId: opts.messageId },
        create: {
          messageId: opts.messageId,
          conversationId: opts.conversationId,
          workspaceId,
          number: opts.number,
          title: opts.title,
          status: opts.status,
          creatorMemberId: opts.creatorMemberId,
          ownerMemberId: opts.ownerMemberId,
          requestId: stableId(`task-request:${opts.key}`),
        },
        update: {
          title: opts.title,
          status: opts.status,
          ownerMemberId: opts.ownerMemberId ?? null,
        },
      });
    await db.$executeRaw`
      UPDATE "conversations" AS c
      SET "nextTaskNumber" = t."next"
      FROM (
        SELECT "conversationId", MAX("number") + 1 AS "next"
        FROM "tasks"
        WHERE "workspaceId" = ${workspaceId}::uuid
        GROUP BY "conversationId"
      ) AS t
      WHERE c."id" = t."conversationId" AND c."nextTaskNumber" < t."next"
    `;
  }

  return { ensureTask, insertPendingTasks };
}
