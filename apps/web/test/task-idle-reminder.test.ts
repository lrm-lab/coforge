import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { readIdleTaskFacts } from "#src/server/tasks/task-idle-reminder-facts.server";
import { idleNudge } from "#src/server/tasks/task-idle-reminder.server";

const HOUR = 3_600_000;
const BASE_TIME = new Date("2026-11-17T12:00:00.000Z");
const at = (hours: number) => new Date(BASE_TIME.getTime() + hours * HOUR);

type StoredTask = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  dueAt?: Date | null;
  createdAt: Date;
  ownerMemberId: string | null;
  ownerAgentId: string | null;
  creatorAgentId: string | null;
  deletedAt?: Date | null;
  messageId?: string | null;
  conversationId?: string;
  discussionConversationId?: string | null;
  channelName?: string | null;
};

type StoredEvent = {
  taskId: string;
  seq: number;
  eventType: string;
  actorType: string;
  actorName: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
};

function createFakeIdleDb(seed: {
  agentId?: string;
  agentName?: string;
  workspaceId?: string;
  tasks: StoredTask[];
  events?: StoredEvent[];
  blockedTaskIds?: string[];
  openSubtaskParentIds?: string[];
}) {
  const workspaceId = seed.workspaceId ?? "ws-1";
  const agentId = seed.agentId ?? "agent-1";
  const agentName = seed.agentName ?? "builder";
  const events = seed.events ?? [];
  const blocked = new Set(seed.blockedTaskIds ?? []);
  const openSubtasks = new Set(seed.openSubtaskParentIds ?? []);
  const reminders = new Map<
    string,
    {
      agentId: string;
      taskId: string;
      reason: string;
      remindedAt: Date;
      staleRemindedAt: Date | null;
    }
  >();
  let lastTaskWhere: unknown;

  function matchesTaskWhere(row: StoredTask, where: Record<string, unknown>): boolean {
    if (row.deletedAt) return false;
    if (Array.isArray(where.OR)) {
      return (where.OR as Record<string, unknown>[]).some((branch) => matchesBranch(row, branch));
    }
    return matchesBranch(row, where);
  }

  function matchesBranch(row: StoredTask, branch: Record<string, unknown>): boolean {
    if ("ownerMemberId" in branch && branch.ownerMemberId === null && row.ownerMemberId !== null) {
      return false;
    }
    if (branch.owner && typeof branch.owner === "object") {
      const wanted = (branch.owner as { agentId?: string }).agentId;
      if (wanted && row.ownerAgentId !== wanted) return false;
    }
    if (branch.creator && typeof branch.creator === "object") {
      const wanted = (branch.creator as { agentId?: string }).agentId;
      if (wanted && row.creatorAgentId !== wanted) return false;
    }
    if (branch.status && typeof branch.status === "object") {
      const statuses = (branch.status as { in?: string[] }).in;
      if (statuses && !statuses.includes(row.status)) return false;
    }
    return true;
  }

  const db = {
    agent: {
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
        where.id === agentId && where.workspaceId === workspaceId ? { name: agentName } : null,
    },
    task: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        lastTaskWhere = where;
        return seed.tasks
          .filter((row) => matchesTaskWhere(row, where))
          .map((row) => ({
            id: row.id,
            number: row.number,
            title: row.title,
            status: row.status,
            priority: row.priority,
            dueAt: row.dueAt ?? null,
            createdAt: row.createdAt,
            ownerMemberId: row.ownerMemberId,
            messageId: row.messageId ?? null,
            conversationId: row.conversationId ?? "conv-1",
            discussionConversationId: row.discussionConversationId ?? null,
            conversation: {
              channelName: row.channelName === undefined ? "coforge" : row.channelName,
              visibility: "public",
              members: [],
            },
            message: null,
          }));
      },
    },
    taskHistoryEvent: {
      groupBy: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = new Set(((where.taskId as { in: string[] })?.in ?? []) as string[]);
        const grouped = new Map<string, Date>();
        for (const event of events) {
          if (!ids.has(event.taskId)) continue;
          if (where.NOT && event.actorType === "system") continue;
          if (Array.isArray(where.OR)) {
            const other =
              event.actorType === "user" ||
              (event.actorType === "agent" && event.actorName !== agentName);
            if (!other) continue;
          }
          const prev = grouped.get(event.taskId);
          if (!prev || event.createdAt > prev) grouped.set(event.taskId, event.createdAt);
        }
        return [...grouped.entries()].map(([taskId, createdAt]) => ({
          taskId,
          _max: { createdAt },
        }));
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = new Set(((where.taskId as { in: string[] })?.in ?? []) as string[]);
        return events
          .filter(
            (event) =>
              ids.has(event.taskId) &&
              (event.eventType === "assignee_changed" || event.eventType === "status_changed"),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seq - a.seq);
      },
    },
    message: {
      groupBy: async () => [],
    },
    taskDependency: {
      findMany: async ({ where }: { where: { taskId: { in: string[] } } }) =>
        where.taskId.in
          .filter((id) => blocked.has(id))
          .map((taskId) => ({
            taskId,
            blocker: {
              id: `blocker-${taskId}`,
              number: 99,
              status: "todo",
              conversation: { channelName: "coforge", visibility: "public" },
            },
          })),
    },
    taskParent: {
      findMany: async ({ where }: { where: { parentTaskId: { in: string[] } } }) =>
        where.parentTaskId.in
          .filter((id) => openSubtasks.has(id))
          .map((parentTaskId) => ({ parentTaskId })),
    },
    taskIdleReminder: {
      findFirst: async ({ where }: { where: { agentId: string } }) => {
        const rows = [...reminders.values()]
          .filter((row) => row.agentId === where.agentId)
          .sort((a, b) => b.remindedAt.getTime() - a.remindedAt.getTime());
        return rows[0] ? { remindedAt: rows[0].remindedAt } : null;
      },
      findMany: async ({ where }: { where: { agentId: string; taskId: { in: string[] } } }) =>
        where.taskId.in.flatMap((id) => {
          const row = reminders.get(`${where.agentId}:${id}`);
          return row ? [row] : [];
        }),
      upsert:
        ({
          where,
          create,
          update,
        }: {
          where: { agentId_taskId: { agentId: string; taskId: string } };
          create: {
            agentId: string;
            taskId: string;
            reason: string;
            remindedAt: Date;
            staleRemindedAt: Date | null;
          };
          update: { reason: string; remindedAt: Date; staleRemindedAt?: Date };
        }) =>
        () => {
          const key = `${where.agentId_taskId.agentId}:${where.agentId_taskId.taskId}`;
          const existing = reminders.get(key);
          if (!existing) {
            reminders.set(key, create);
          } else {
            reminders.set(key, {
              ...existing,
              reason: update.reason,
              remindedAt: update.remindedAt,
              ...(update.staleRemindedAt ? { staleRemindedAt: update.staleRemindedAt } : {}),
            });
          }
        },
    },
    $transaction: async (ops: (() => void)[]) => {
      for (const op of ops) op();
    },
  };

  return {
    db: db as unknown as PrismaClient,
    principal: { workspaceId, agentId },
    getLastTaskWhere: () => lastTaskWhere,
  };
}

describe("idle task reminders for unassigned creator tasks", () => {
  test("readIdleTaskFacts includes open todo/in_progress tasks created by the Agent with no assignee, excluding others' or in_review/done", async () => {
    const { db } = createFakeIdleDb({
      tasks: [
        {
          id: "t-assigned",
          number: 1,
          title: "Assigned to me",
          status: "todo",
          priority: "high",
          createdAt: at(-1),
          ownerMemberId: "member-agent-1",
          ownerAgentId: "agent-1",
          creatorAgentId: "agent-2",
        },
        {
          id: "t-unassigned-todo",
          number: 2,
          title: "Subtask split out without assignee",
          status: "todo",
          priority: "urgent",
          createdAt: at(-0.1),
          ownerMemberId: null,
          ownerAgentId: null,
          creatorAgentId: "agent-1",
        },
        {
          id: "t-unassigned-progress",
          number: 3,
          title: "In-progress unassigned creator task",
          status: "in_progress",
          priority: "medium",
          createdAt: at(-0.1),
          ownerMemberId: null,
          ownerAgentId: null,
          creatorAgentId: "agent-1",
        },
        {
          id: "t-assigned-other",
          number: 4,
          title: "Created by me, assigned to teammate",
          status: "todo",
          priority: "urgent",
          createdAt: at(-0.1),
          ownerMemberId: "member-agent-2",
          ownerAgentId: "agent-2",
          creatorAgentId: "agent-1",
        },
        {
          id: "t-unassigned-review",
          number: 5,
          title: "Unassigned in review",
          status: "in_review",
          priority: "high",
          createdAt: at(-0.1),
          ownerMemberId: null,
          ownerAgentId: null,
          creatorAgentId: "agent-1",
        },
        {
          id: "t-unassigned-done",
          number: 6,
          title: "Unassigned done",
          status: "done",
          priority: "high",
          createdAt: at(-0.1),
          ownerMemberId: null,
          ownerAgentId: null,
          creatorAgentId: "agent-1",
        },
      ],
    });

    const facts = await readIdleTaskFacts(db, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      name: "builder",
    });

    expect(facts.map((task) => task.taskNumber)).toEqual([1, 2, 3]);
    expect(facts.find((task) => task.taskNumber === 1)?.unassigned).toBe(false);
    expect(facts.find((task) => task.taskNumber === 2)?.unassigned).toBe(true);
    expect(facts.find((task) => task.taskNumber === 3)?.unassigned).toBe(true);
  });

  test("an unassigned subtask created by the Agent is surfaced once on idle, repeated on freshSession or 24h stale, and never shifts assigned queue positions", async () => {
    const { db, principal } = createFakeIdleDb({
      tasks: [
        {
          id: "t-assigned",
          number: 10,
          title: "Owned task",
          status: "todo",
          priority: "low",
          createdAt: at(-0.1),
          ownerMemberId: "member-agent-1",
          ownerAgentId: "agent-1",
          creatorAgentId: " user",
        },
        {
          id: "t-unassigned",
          number: 11,
          title: "Forgotten subtask",
          status: "todo",
          priority: "urgent",
          createdAt: at(-0.05),
          ownerMemberId: null,
          ownerAgentId: null,
          creatorAgentId: "agent-1",
        },
      ],
      events: [
        {
          taskId: "t-assigned",
          seq: 1,
          eventType: "assignee_changed",
          actorType: "user",
          actorName: "alice",
          payload: { assigneeId: "agent-1", assigneeType: "agent" },
          createdAt: at(-0.1),
        },
      ],
    });

    const first = await idleNudge(db, principal, {}, at(0));
    expect(first.send).toBe(true);
    expect(first.items).toEqual([
      expect.objectContaining({
        taskNumber: 10,
        queuePosition: 1,
        reason: "newly_assigned",
        why: "newly assigned to you",
      }),
      expect.objectContaining({
        taskNumber: 11,
        reason: "newly_assigned",
        why: "created by you with no assignee",
      }),
    ]);
    expect(first.items[1]).not.toHaveProperty("queuePosition");
    expect(first.text).toContain("claim or assign");

    // Asking again after an hour does not repeat the reminder without new activity.
    expect(await idleNudge(db, principal, {}, at(1.2))).toMatchObject({
      send: false,
      reason: "no_change",
    });

    // A fresh session surfaces both again, still identifying the unassigned creator task.
    const fresh = await idleNudge(db, principal, { freshSession: true }, at(1.3));
    expect(fresh.send).toBe(true);
    expect(fresh.items.map((item) => [item.taskNumber, item.reason])).toEqual([
      [10, "new_session"],
      [11, "new_session"],
    ]);
    expect(fresh.items[1]?.why).toContain("no assignee");

    // After 24 hours of silence, both surface as stale.
    const stale = await idleNudge(db, principal, {}, at(26));
    expect(stale.send).toBe(true);
    expect(stale.items.map((item) => [item.taskNumber, item.reason])).toEqual([
      [10, "stale"],
      [11, "stale"],
    ]);
    expect(stale.items[1]?.why).toContain("no assignee");
  });

  test("when only unassigned creator tasks are due, prompt instructs the Agent to claim or assign them instead of saying none can start", async () => {
    const { db, principal } = createFakeIdleDb({
      tasks: [
        {
          id: "t-unassigned",
          number: 7,
          title: "Split out parser fix",
          status: "todo",
          priority: "high",
          createdAt: at(-0.05),
          ownerMemberId: null,
          ownerAgentId: null,
          creatorAgentId: "agent-1",
        },
      ],
    });

    const res = await idleNudge(db, principal, {}, at(0));
    expect(res.send).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).not.toHaveProperty("queuePosition");
    expect(res.text).toContain("Claim or assign");
    expect(res.text).not.toContain("None of these can start yet");
  });

  test("a task the Agent created, claimed, and intentionally unclaimed is not immediately nagged as forgotten", async () => {
    const { db, principal } = createFakeIdleDb({
      tasks: [
        {
          id: "t-unclaimed",
          number: 8,
          title: "Released back to pool",
          status: "todo",
          priority: "medium",
          createdAt: at(-0.2),
          ownerMemberId: null,
          ownerAgentId: null,
          creatorAgentId: "agent-1",
        },
      ],
      events: [
        {
          taskId: "t-unclaimed",
          seq: 2,
          eventType: "assignee_changed",
          actorType: "agent",
          actorName: "builder",
          payload: { assigneeId: "agent-1", assigneeType: "agent" },
          createdAt: at(-0.15),
        },
        {
          taskId: "t-unclaimed",
          seq: 3,
          eventType: "assignee_changed",
          actorType: "agent",
          actorName: "builder",
          payload: { assigneeId: null, assigneeType: null },
          createdAt: at(-0.1),
        },
      ],
    });

    expect(await idleNudge(db, principal, {}, at(0))).toMatchObject({
      send: false,
      reason: "no_change",
    });
    const fresh = await idleNudge(db, principal, { freshSession: true }, at(0.1));
    expect(fresh.send).toBe(true);
    expect(fresh.items[0]?.taskNumber).toBe(8);
  });
});
