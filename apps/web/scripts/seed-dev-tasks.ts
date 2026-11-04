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
          id: opts.messageId,
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
    // task #507: one new-shape Task whose `id` is a fresh uuid(7), not its message's. Its
    // source message is written here — `ensureMessage` only queues, and the queue already
    // flushed into rows before this ran.
    const newShapeMessageId = stableId("task:new-shape:message");
    const { _max } = await db.message.aggregate({
      where: { conversationId: pendingTasks[0]!.conversationId },
      _max: { sequence: true },
    });
    await db.message.upsert({
      where: { id: newShapeMessageId },
      create: {
        id: newShapeMessageId,
        conversationId: pendingTasks[0]!.conversationId,
        workspaceId,
        senderMemberId: pendingTasks[0]!.senderMemberId,
        body: "A task reclaimed after its predecessor was cleaned up",
        sequence: (_max.sequence ?? 0) + 1,
        createdAt: deps.daysAgo(1, 16),
      },
      update: {},
    });
    await db.task.upsert({
      where: { messageId: newShapeMessageId },
      create: {
        id: stableId("task:new-shape"),
        messageId: newShapeMessageId,
        conversationId: pendingTasks[0]!.conversationId,
        workspaceId,
        number: 999,
        title: "A task reclaimed after its predecessor was cleaned up",
        status: "in_progress",
        creatorMemberId: pendingTasks[0]!.creatorMemberId,
        ownerMemberId: pendingTasks[0]!.creatorMemberId,
        requestId: stableId("task-request:new-shape"),
      },
      update: {},
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
