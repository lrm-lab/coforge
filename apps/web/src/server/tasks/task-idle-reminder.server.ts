import type {
  AgentTaskIdleItem,
  AgentTaskIdleNudgeRequest,
  AgentTaskIdleNudgeResponse,
  AgentTaskIdleReason,
  AgentTaskIdleSkipReason,
} from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import type { PrismaClient } from "#src/generated/prisma/client";
import { taskConversationsEnabled } from "./task-conversations-gate.server";
import { readIdleTaskFacts, type IdleTaskFacts } from "./task-idle-reminder-facts.server";
import { byPriority } from "./task-priority.server";

/**
 * The idle task reminder (`POST /api/agent/v1/tasks/idle-nudge`): when an Agent's Computer finds
 * it idle, which of the Agent's open Tasks to remind it of, why, and the text to give it. Only in
 * a Workspace with Tasks v2 on. A reminder is recorded as soon as it is answered.
 */

const HOUR = 3_600_000;
/** A Task with no activity this long is stale; and it is reminded as stale at most this often. */
export const STALE_AFTER_MS = 24 * HOUR;
/** At most one reminder an Agent an hour, a fresh session's excepted. */
export const REMINDER_INTERVAL_MS = HOUR;
/** Listed in full; the rest are named in the backlog. */
export const LISTED_ITEMS = 5;

const skip = (reason: AgentTaskIdleSkipReason): AgentTaskIdleNudgeResponse => ({
  send: false,
  reason,
  items: [],
  backlog: [],
  text: "",
});

type Reminder = { remindedAt: Date; staleRemindedAt: Date | null };

const later = (left: Date, right: Date) => (left > right ? left : right);

/** Why `task` is worth a reminder now, or null. */
function reasonFor(
  task: IdleTaskFacts,
  reminder: Reminder | undefined,
  input: AgentTaskIdleNudgeRequest,
  now: Date,
): { reason: AgentTaskIdleReason; why: string } | null {
  // A Task never reminded (every Task, when this first runs) counts only the last day as new, so
  // an assignment or a reply of last month is not reported as just now.
  const dayAgo = new Date(now.getTime() - STALE_AFTER_MS);
  const newSince = reminder?.remindedAt ?? dayAgo;
  // Others acted after the last reminder, or else after it was given (within the last day).
  const since = reminder?.remindedAt ?? later(task.givenAt ?? task.createdAt, dayAgo);
  const after = (date: Date | null) => date !== null && date > since;
  if (task.givenAt && !task.givenBySelf && task.givenAt > newSince)
    return { reason: "newly_assigned", why: "newly assigned to you" };
  if (input.freshSession && !task.ownReview)
    return { reason: "new_session", why: "you started a new session" };
  if (task.blockerDone && after(task.blockerDone.at))
    return {
      reason: "others_acted",
      why: task.blockerDone.ref
        ? `the task it waits for, ${task.blockerDone.ref}, is done`
        : "the task it waits for is done",
    };
  if (after(task.othersRepliedAt))
    return { reason: "others_acted", why: "someone else replied in its conversation" };
  if (after(task.othersChangedAt))
    return { reason: "others_acted", why: "someone else changed it" };
  const quiet = now.getTime() - task.lastActivityAt.getTime() >= STALE_AFTER_MS;
  const staleAgain =
    !reminder?.staleRemindedAt ||
    now.getTime() - reminder.staleRemindedAt.getTime() >= STALE_AFTER_MS;
  // Never stale: work waiting on background tasks, its own review, a blocker or a subtask.
  const held =
    (input.backgroundTasks ?? 0) > 0 || task.ownReview || task.blocked || task.openSubtasks;
  if (!held && quiet && staleAgain) return { reason: "stale", why: "no activity for 24 hours" };
  return null;
}

/** The reminder text an idle Agent is given, from the items and backlog it lists. */
export function idleReminderText(items: AgentTaskIdleItem[], backlog: { ref: string }[]) {
  return [
    "[Idle task reminder] Open tasks assigned to you, highest priority first:",
    ...items.map(
      (item) =>
        `- ${item.ref} [${item.status}] prio=${item.priority} "${item.title}" — ${item.why}`,
    ),
    "Pick up the highest-priority one, or update a task's status if it is done or blocked. Read a task with `coforge task view '<ref>'`.",
    ...(backlog.length > 0
      ? [`(${backlog.length} more: ${backlog.map((item) => item.ref).join(", ")})`]
      : []),
  ].join("\n");
}

/** Decide, and record, one idle reminder for the Agent `principal`. */
export async function idleNudge(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  input: AgentTaskIdleNudgeRequest,
  now = new Date(),
): Promise<AgentTaskIdleNudgeResponse> {
  if (!(await taskConversationsEnabled(db, principal))) return skip("disabled");
  const agent = await db.agent.findFirst({
    where: { id: principal.agentId, workspaceId: principal.workspaceId },
    select: { name: true },
  });
  if (!agent) throw new AppError("NOT_FOUND");
  // The cap first: most idle turns inside the hour then cost three reads. It reads the newest row,
  // which goes with its Task: deleting the Task reminded last lifts the cap early.
  if (!input.freshSession) {
    const last = await db.taskIdleReminder.findFirst({
      where: { agentId: principal.agentId },
      orderBy: { remindedAt: "desc" },
      select: { remindedAt: true },
    });
    if (last && now.getTime() - last.remindedAt.getTime() < REMINDER_INTERVAL_MS)
      return skip("hourly_cap");
  }
  const tasks = await readIdleTaskFacts(db, { ...principal, name: agent.name });
  if (tasks.length === 0) return skip("no_open_tasks");

  const rows = await db.taskIdleReminder.findMany({
    where: { agentId: principal.agentId, taskId: { in: tasks.map((task) => task.id) } },
    select: { taskId: true, remindedAt: true, staleRemindedAt: true },
  });
  const reminders = new Map(rows.map((row) => [row.taskId, row]));
  const due = tasks.flatMap((task) => {
    const reason = reasonFor(task, reminders.get(task.id), input, now);
    return reason ? [{ task, ...reason }] : [];
  });
  if (due.length === 0) return skip("no_change");

  const ordered = byPriority(
    due.map((entry) => ({ ...entry, priority: entry.task.priority })),
    (left, right) =>
      left.task.createdAt.getTime() - right.task.createdAt.getTime() ||
      left.task.id.localeCompare(right.task.id),
  );
  const listed = ordered.slice(0, LISTED_ITEMS);
  const items = listed.map(({ task, reason, why }) => ({
    ref: task.ref,
    taskNumber: task.taskNumber,
    channel: task.channel,
    title: task.title,
    status: task.status,
    priority: task.priority,
    reason,
    why,
  }));
  const backlog = ordered
    .slice(LISTED_ITEMS)
    .map(({ task }) => ({ ref: task.ref, title: task.title }));
  // Only the listed Tasks count as reminded: the backlog comes up again next time.
  await db.$transaction(
    listed.map(({ task, reason }) =>
      db.taskIdleReminder.upsert({
        where: { agentId_taskId: { agentId: principal.agentId, taskId: task.id } },
        create: {
          agentId: principal.agentId,
          taskId: task.id,
          workspaceId: principal.workspaceId,
          reason,
          remindedAt: now,
          staleRemindedAt: reason === "stale" ? now : null,
        },
        update: { reason, remindedAt: now, ...(reason === "stale" && { staleRemindedAt: now }) },
      }),
    ),
  );
  return { send: true, items, backlog, text: idleReminderText(items, backlog) };
}
