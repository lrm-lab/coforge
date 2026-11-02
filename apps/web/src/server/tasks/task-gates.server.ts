import {
  isBlockerSatisfied,
  taskNameLabel,
  type TaskName,
  type TaskRef,
  type TaskStatus,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { SystemNoticeContent, SystemPerson } from "#src/features/conversations/system-notice";
import type { Member, Transaction } from "./task-board-ports.server";
import {
  isActor,
  linkNewTasks,
  TASK_RELATION_DENIED,
  TASK_RELATION_INVALID,
  type RelationPlan,
} from "./task-relations-write.server";
import { isTaskManager } from "./task-assignees.server";
import { TASK_RELATIONS_OFF, taskRelationsEnabled } from "./task-conversations-gate.server";
import type { NoticeSubject, NoticeWriter } from "./task-notice-posting.server";
import {
  assigneeMention,
  noticeActor,
  noticeText,
  type AssigneeMention,
  type QuotedTask,
} from "./task-notices.server";
import { indexedRequestId } from "./task-request-ids.server";
import { byName, NOT_BLOCKED_WHERE, notBlockedWhere } from "./task-relations.server";
import {
  NAMED_CONVERSATION_SELECT,
  taskName,
  taskSelection,
  UNFINISHED_TASK_STATUSES,
  type SelectedTask,
} from "./task-view.server";

/**
 * What a Task's blockers and subtasks hold back, for everyone but a Workspace owner or admin, and
 * the notices that tell a Task's owner when that changes. A refusal is `CONFLICT` and its hint
 * (the Agent's refusal text, printed by the CLI) names what blocks the Task and what happens next.
 */

export const TASK_BLOCKED = "task_blocked";
export const TASK_SUBTASKS_OPEN = "task_subtasks_open";

/** The error ids whose hints are written for an Agent to read; the Agent route returns only these. */
export const AGENT_FACING_ERROR_IDS: ReadonlySet<string> = new Set([
  TASK_BLOCKED,
  TASK_SUBTASKS_OPEN,
  TASK_RELATION_DENIED,
  TASK_RELATION_INVALID,
  TASK_RELATIONS_OFF,
]);

const names = (open: readonly TaskName[]) => open.map(taskNameLabel).join(", ");

/** The blockers of `task` that are not done or closed, as `task`'s conversation names them. */
export async function openBlockers(
  tx: Transaction,
  task: { id: string; conversationId: string },
): Promise<TaskName[]> {
  const rows = await tx.taskDependency.findMany({
    where: { taskId: task.id, blocker: { status: { in: UNFINISHED_TASK_STATUSES } } },
    select: {
      blocker: { select: { number: true, conversation: { select: NAMED_CONVERSATION_SELECT } } },
    },
  });
  return rows.map((row) => taskName(row.blocker, task.conversationId)).sort(byName);
}

/** The subtasks of `task` that are not done or closed, named the same way. */
export async function openSubtasks(
  tx: Transaction,
  task: { id: string; conversationId: string },
  /** A subtask to leave out: the one being deleted. */
  except?: string,
): Promise<TaskName[]> {
  const rows = await tx.taskParent.findMany({
    where: {
      parentTaskId: task.id,
      task: { status: { in: UNFINISHED_TASK_STATUSES }, ...(except && { id: { not: except } }) },
    },
    select: {
      task: { select: { number: true, conversation: { select: NAMED_CONVERSATION_SELECT } } },
    },
  });
  return rows.map((row) => taskName(row.task, task.conversationId)).sort(byName);
}

/** The refusal of work on a Task that waits for `open`. */
export function blockedRefusal(task: { number: number }, open: readonly TaskName[], what: string) {
  return new AppError("CONFLICT", {
    errorId: TASK_BLOCKED,
    details: { number: task.number, blockedBy: JSON.stringify(open) },
    hint: `task #${task.number} is blocked: it is waiting for ${names(open)}, so you cannot ${what} yet. Do not start it; its owner is notified in the task's thread when the last one finishes. Pick another task meanwhile.`,
  });
}

/** The refusal of finishing a Task whose subtasks `open` are not. */
export function subtasksOpenRefusal(
  task: { number: number },
  open: readonly TaskName[],
  to: TaskStatus,
) {
  return new AppError("CONFLICT", {
    errorId: TASK_SUBTASKS_OPEN,
    details: { number: task.number, subtasks: JSON.stringify(open) },
    hint: `task #${task.number} still has open sub-tasks ${names(open)}, so you cannot move it to ${to} yet. Finish or close them first; its owner is notified in the task's thread when the last one finishes.`,
  });
}

/**
 * Refuse a move into `to` that a Task's blockers or subtasks hold back, unless the actor manages
 * Tasks: a blocked Task does not start, go to review or finish, and a Task with open subtasks does
 * not go to review, finish or close. Every status write passes through here (`commitTaskChange`).
 */
export async function assertMayEnter(
  tx: Transaction,
  task: { id: string; number: number; status: string; conversationId: string; workspaceId: string },
  to: TaskStatus,
  manager: boolean,
) {
  if (manager || to === task.status) return;
  // Without Tasks v2 nothing holds a Task back; the links already written wait for it.
  if (!(await taskRelationsEnabled(tx, task.workspaceId))) return;
  if (to === "in_progress" || to === "in_review" || to === "done") {
    const open = await openBlockers(tx, task);
    if (open.length) throw blockedRefusal(task, open, `move it to ${to}`);
  }
  if (to === "in_review" || to === "done" || to === "closed") {
    const open = await openSubtasks(tx, task);
    if (open.length) throw subtasksOpenRefusal(task, open, to);
  }
}

/**
 * Link the Tasks a `create` just made to the blockers and parent it named. A Task made already
 * started (assigned to its creator) cannot wait for an unfinished blocker, for anyone but a
 * manager, as a status move to In Progress could not.
 */
export async function linkCreatedTasks(
  tx: Transaction,
  scope: { conversationId: string; workspaceId: string },
  member: Member,
  tasks: readonly SelectedTask[],
  input: { blockedBy?: TaskRef[]; parent?: TaskRef | null },
) {
  const started = tasks.find((task) => task.status === "in_progress");
  const manager = await isTaskManager(tx, scope.workspaceId, member);
  const open = await linkNewTasks(tx, scope, member, tasks, input, manager);
  if (open.length && started && !manager) throw blockedRefusal(started, open, "start it");
}

type Owner = NonNullable<SelectedTask["owner"]>;

/** The Agent a notice wakes: the owner, unless they are the one who caused it, left or are deleted. */
function wakeTarget(owner: Owner | null, actor: Member | null): string | null {
  if (!owner?.agentId || (actor && isActor(owner, actor)) || owner.leftAt || owner.agent?.deletedAt)
    return null;
  return owner.agentId;
}

/** Whether a notice about `task` is for its owner to read: it has one, and they did not cause it. */
const addressable = (task: SelectedTask, actor: Member) =>
  !!task.owner && !isActor(task.owner, actor);

/** What a notice builder is given about the Task it is for: its quoted form and its owner. */
type Addressee = { task: QuotedTask; mention: AssigneeMention | null; owner: SystemPerson | null };

/**
 * Post a notice in `task`'s thread addressed to its owner: mentioned, and woken when an Agent
 * other than `actor`. `related` are the other Tasks the notice names, quoted as `task`'s own
 * conversation names them. `seed` fixes the notice's id, so a retry posts none twice; `build`
 * gives the text and the structured content, which carries the same `owner`.
 */
async function notify(
  notices: NoticeWriter,
  actor: Member,
  task: SelectedTask,
  related: readonly NoticeSubject[],
  seed: string,
  build: (addressee: Addressee, related: QuotedTask[]) => SystemNoticeContent,
) {
  // A departed owner is not mentioned or woken; the notice is just posted.
  const owner = task.owner?.leftAt ? null : task.owner;
  await notices.toOwner({
    id: await indexedRequestId(seed, 1),
    task,
    related,
    owner,
    deliverTo: wakeTarget(owner, actor),
    content: (quoted, quotedRelated) =>
      build(
        {
          task: quoted,
          mention: owner && assigneeMention(owner),
          owner: owner && noticeActor(owner),
        },
        quotedRelated,
      ),
  });
}

/** The "now blocked" notice: a Task under way waits for the related Tasks. */
const blockedNotice = ({ task, mention, owner }: Addressee, blockers: QuotedTask[]) =>
  ({
    body: noticeText.blocked(task, blockers, mention),
    system: { kind: "task.blocked", params: { task, blockers, owner } },
  }) satisfies SystemNoticeContent;

/**
 * Notices after `before` became `after` (the status of one Task changed), each to its Task's owner
 * only. Finished: each Task that was waiting for it and has no other open blocker now (4b), and its
 * parent when it was the last open subtask (4c). Reopened: each Task under way that waits for it
 * waits again, told as if the blocker had just been added. The Tasks may be in any conversation of
 * the Workspace; those in another are told in their own after the commit.
 */
export async function noticeStatusFollowUps(
  tx: Transaction,
  notices: NoticeWriter,
  actor: Member,
  before: { status: string },
  after: SelectedTask,
) {
  const wasFinished = isBlockerSatisfied(before.status);
  if (wasFinished === isBlockerSatisfied(after.status)) return;
  if (!(await taskRelationsEnabled(tx, after.workspaceId))) return;
  const [waiting, parent] = await Promise.all([
    tx.task.findMany({
      where: {
        AND: [
          { dependencies: { some: { blockedByTaskId: after.id } } },
          wasFinished
            ? { status: { in: ["in_progress", "in_review"] } }
            : { status: { in: UNFINISHED_TASK_STATUSES }, AND: [NOT_BLOCKED_WHERE] },
        ],
        ownerMemberId: { not: null },
      },
      select: taskSelection,
    }),
    wasFinished ? null : parentFinishedBy(tx, after.id, actor),
  ]);
  const dependents = waiting.filter((task) => addressable(task, actor));
  const key = `${after.id}:${after.revision}`;
  await notices.prepare([...dependents, ...(parent ? [parent] : [])].map((t) => t.conversationId));
  for (const task of dependents)
    await notify(
      notices,
      actor,
      task,
      [after],
      `${wasFinished ? "blocked" : "unblocked"}:${task.id}:${key}`,
      wasFinished
        ? (addressee, [finished]) => blockedNotice(addressee, [finished!])
        : ({ task: subject, mention, owner }, [finished]) => ({
            body: noticeText.unblocked(finished!, subject, mention),
            system: {
              kind: "task.unblocked",
              params: { task: subject, blocker: finished!, owner },
            },
          }),
    );
  if (parent) await notifySubtasksFinished(notices, actor, parent, key);
}

/**
 * The parent of `childId` when `childId` was its last open subtask and its owner, who did not
 * cause this, is to be told; `except` is a subtask being deleted, which no longer counts.
 */
async function parentFinishedBy(tx: Transaction, childId: string, actor: Member, except?: string) {
  const link = await tx.taskParent.findUnique({
    where: { taskId: childId },
    select: { parent: { select: taskSelection } },
  });
  const parent = link?.parent;
  if (!parent || isBlockerSatisfied(parent.status) || !addressable(parent, actor)) return null;
  return (await openSubtasks(tx, parent, except)).length ? null : parent;
}

const notifySubtasksFinished = (
  notices: NoticeWriter,
  actor: Member,
  parent: SelectedTask,
  key: string,
) =>
  notify(
    notices,
    actor,
    parent,
    [],
    `subtasks-finished:${parent.id}:${key}`,
    ({ task: subject, mention, owner }) => ({
      body: noticeText.subtasksFinished(subject, mention),
      system: { kind: "task.subtasks_finished", params: { task: subject, owner } },
    }),
  );

/**
 * Deleting an open subtask can be what finishes its parent's subtasks: tell the parent's owner,
 * as finishing the subtask would have. A subtask that was finished already counted.
 */
export async function noticeSubtaskDeleted(
  tx: Transaction,
  notices: NoticeWriter,
  actor: Member,
  task: { id: string; status: string; workspaceId: string },
) {
  if (isBlockerSatisfied(task.status) || !(await taskRelationsEnabled(tx, task.workspaceId)))
    return;
  const parent = await parentFinishedBy(tx, task.id, actor, task.id);
  if (parent) await notices.prepare([parent.conversationId]);
  if (parent) await notifySubtasksFinished(notices, actor, parent, `deleted:${task.id}`);
}

/**
 * Tell the owners of `tasks` they no longer wait for anything (4b, when the last blocker did not
 * finish but went away: it was removed by an amendment or deleted). An owner who caused it knows;
 * a Task nobody holds is told no one. `key` fixes the notices' ids, so a retry posts none twice.
 */
export async function noticeReleased(
  notices: NoticeWriter,
  actor: Member,
  tasks: readonly SelectedTask[],
  key: string,
) {
  // A Task that finished meanwhile has nothing left to start.
  const told = tasks.filter((task) => addressable(task, actor) && !isBlockerSatisfied(task.status));
  await notices.prepare(told.map((task) => task.conversationId));
  for (const task of told)
    await notify(
      notices,
      actor,
      task,
      [],
      `released:${task.id}:${key}`,
      ({ task: subject, mention, owner }) => ({
        body: noticeText.released(subject, mention),
        system: { kind: "task.released", params: { task: subject, owner } },
      }),
    );
}

/**
 * The unfinished Tasks that wait for `blockerId` alone: they have an owner and no other open
 * blocker, so losing this one frees them. Empty when the blocker is itself finished already.
 */
export async function onlyWaitingFor(
  tx: Transaction,
  blocker: { id: string; workspaceId: string },
) {
  const blockerId = blocker.id;
  if (!(await taskRelationsEnabled(tx, blocker.workspaceId))) return [];
  return tx.task.findMany({
    where: {
      AND: [
        {
          dependencies: {
            some: {
              blockedByTaskId: blockerId,
              blocker: { status: { in: UNFINISHED_TASK_STATUSES } },
            },
          },
        },
        notBlockedWhere(blockerId),
      ],
      status: { in: UNFINISHED_TASK_STATUSES },
      ownerMemberId: { not: null },
    },
    select: taskSelection,
  });
}

/**
 * The notice to the owner of a Task that is under way when it gains a blocker that is not
 * finished (4a): it waits now. A Task with no owner, or not started, is told nobody.
 */
export async function noticeNowBlocked(
  tx: Transaction,
  notices: NoticeWriter,
  actor: Member,
  task: SelectedTask,
  plan: Pick<RelationPlan, "newlyOpenBlockers">,
) {
  if (!plan.newlyOpenBlockers.length || !addressable(task, actor)) return;
  if (task.status !== "in_progress" && task.status !== "in_review") return;
  const blockers = await tx.task.findMany({
    where: { id: { in: plan.newlyOpenBlockers } },
    select: { id: true, messageId: true, number: true, title: true, conversationId: true },
    orderBy: [{ conversationId: "asc" }, { number: "asc" }],
  });
  await notify(
    notices,
    actor,
    task,
    blockers,
    `blocked:${task.id}:${task.revision}`,
    blockedNotice,
  );
}
