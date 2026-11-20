import { BROWSER_MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { TASK_CLAIM_BLOCKED_ACTIONS } from "@lrm/coforge-sdk/internal";
import {
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_PATTERN,
  type TaskClaimConflict,
  type TaskClaimResult,
  type TaskCommand,
  type TaskName,
  type TaskResult,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { AppError } from "#src/lib/app-error";
import { storedTaskStatus, taskMember, taskSelection, type SelectedTask } from "./task-view.server";
import { taskViewOf } from "./task-relations.server";
import { TASK_BLOCKED } from "./task-gates.server";
import type {
  Transaction,
  TaskBoardPorts,
  Member,
  ConversationRef,
} from "./task-board-ports.server";
import { memberId } from "./task-board-ports.server";
import {
  findTaskByNumber,
  commitTaskChange,
  ensureTaskExecutionSession,
  withoutAssignee,
} from "./task-change.server";
import { withNotices } from "./task-notice-posting.server";
import { signalTaskChange } from "./task-publication.server";

/** The short forms a message id may be written in (the CLI prints `xxxxxxxx-xxxx`), which address
 * a Message by anchor rather than by the whole id. */
const MESSAGE_ANCHOR = new RegExp(`^(?:${MESSAGE_ANCHOR_SOURCE})$`, "i");

/** Why a claim selector was refused, as its result row states it. */
const CLAIM_REFUSAL = {
  taskNotFound: "task not found",
  held: "already claimed",
  blocked: "blocked",
  changed: "the task changed while it was being claimed; read it again",
} as const;

/** What another member's hold on a Task leaves open. Illustrative, not a permission table. */
const CLAIM_CONFLICT_UNBLOCKED_EXAMPLES = [
  "replying in the task's thread",
  "reading the task and its history",
  "amending the task card",
  "asking a person to reassign it",
];

/** A claim selector the board refused; `claim` turns it into that selector's result row. */
class ClaimRefused extends Error {
  constructor(
    readonly reason: string,
    readonly conflict?: TaskClaimConflict,
  ) {
    super(reason);
  }
}

/** Another member holds `task`: who, since when, and as of which instant this was read. */
function claimConflict(task: SelectedTask): TaskClaimConflict {
  const owner = taskMember(task.workspaceId, task.owner!);
  return {
    kind: "claim_conflict",
    conflictScope: "implementation_execution",
    blockedActions: [...TASK_CLAIM_BLOCKED_ACTIONS],
    unblockedActionExamples: CLAIM_CONFLICT_UNBLOCKED_EXAMPLES,
    currentAssignee: {
      type: owner.kind,
      name: owner.handle,
      ...(owner.deleted && { deleted: true }),
    },
    taskStatus: storedTaskStatus(task.status, { number: task.number }),
    claimedAt: task.claimedAt?.toISOString() ?? null,
    observedAt: new Date().toISOString(),
  };
}

/**
 * A person's claim either lands or fails as a whole, so the page that showed it can take it
 * back: refuse a claim result in which no selector was claimed.
 */
export function refuseUnclaimed(result: TaskResult): void {
  const claims = result.claims ?? [];
  if (claims.some((claim) => claim.success)) return;
  throw new AppError(
    claims.every((claim) => claim.reason === CLAIM_REFUSAL.taskNotFound) ? "NOT_FOUND" : "CONFLICT",
  );
}

export async function findSourceMessageRootId(
  tx: Pick<Transaction, "message">,
  conversationId: string,
  messageId: string,
): Promise<string | null> {
  const anchor = MESSAGE_ANCHOR.test(messageId) ? messageId : undefined;
  if (!anchor && !UUID_LIKE_PATTERN.test(messageId)) return null;
  const messages = await tx.message.findMany({
    where: anchor
      ? { conversationId, id: messageAnchorWhere(anchor) }
      : { conversationId, id: messageId },
    take: 2,
    select: { id: true, threadRootId: true },
  });
  if (messages.length !== 1) return null;
  const matched = messages[0]!;
  return matched.threadRootId ?? matched.id;
}

export async function findSourceMessage(
  tx: Pick<Transaction, "message">,
  conversationId: string,
  messageId: string,
  { allowThreadReply }: { allowThreadReply: boolean },
) {
  const anchor = MESSAGE_ANCHOR.test(messageId) ? messageId : undefined;
  if (!anchor && !UUID_LIKE_PATTERN.test(messageId)) throw new AppError("NOT_FOUND");
  const select = {
    id: true,
    body: true,
    senderMemberId: true,
    threadRootId: true,
    mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
  } as const;
  const messages = await tx.message.findMany({
    where: {
      conversationId,
      id: anchor ? messageAnchorWhere(anchor) : messageId,
      ...(!allowThreadReply ? { threadRootId: null } : {}),
    },
    take: 2,
    select,
  });
  if (messages.length !== 1) throw new AppError(messages.length ? "CONFLICT" : "NOT_FOUND");
  const matched = messages[0]!;
  if (!matched.threadRootId) return { ...matched, sourceThreadReplyId: undefined };
  const root = await tx.message.findFirst({
    where: { conversationId, id: matched.threadRootId, threadRootId: null },
    select,
  });
  if (!root) throw new AppError("NOT_FOUND");
  return { ...root, sourceThreadReplyId: matched.id };
}

async function claimTask(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  number: number,
) {
  const { conversationId } = conversation;
  const task = await withNotices(ports, conversation, async (tx) => {
    const existing = await findTaskByNumber(tx, conversationId, number);
    if (!existing) throw new ClaimRefused(CLAIM_REFUSAL.taskNotFound);
    if (
      existing.ownerMemberId === member.id &&
      existing.claimedAt !== null &&
      existing.status === "in_progress"
    ) {
      if (member.agentId && existing.status === "in_progress" && !existing.executionSessions[0]) {
        await ensureTaskExecutionSession(tx, existing, member.agentId);
        return tx.task.findUniqueOrThrow({
          where: { id: existing.id },
          select: taskSelection,
        });
      }
      return existing;
    }
    if (existing.status === "done" || existing.status === "closed")
      throw new ClaimRefused(`task is ${existing.status}`);
    if (existing.ownerMemberId && existing.ownerMemberId !== member.id)
      throw new ClaimRefused(CLAIM_REFUSAL.held, claimConflict(existing));
    const { task: claimed } = await commitTaskChange(
      tx,
      member,
      existing,
      { ownerMemberId: existing.ownerMemberId, status: existing.status },
      {
        ownerMemberId: memberId(member),
        claimedAt: new Date(),
        ...((existing.status === "todo" || existing.status === "backlog") && {
          status: "in_progress" as const,
        }),
      },
    );
    return claimed;
  });
  const view = await taskViewOf(ports.db, ports.reader, task);
  await signalTaskChange(ports, task, { view });
  return view;
}

export async function claimTasks(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  command: TaskCommand,
): Promise<TaskResult> {
  const numbers = new Set([
    ...(command.numbers ?? []),
    ...(command.number ? [command.number] : []),
  ]);
  // Every selector gets its own result row: a refused claim is an answer, not an error.
  const tasks: TaskView[] = [];
  const claims: TaskClaimResult[] = [];
  for (const number of numbers) {
    try {
      const task = await claimTask(ports, conversation, member, number);
      tasks.push(task);
      claims.push({ number: task.number, messageId: task.messageId ?? undefined, success: true });
    } catch (error) {
      if (error instanceof ClaimRefused)
        claims.push({
          number,
          success: false,
          reason: error.reason,
          ...(error.conflict && { conflict: error.conflict }),
        });
      // The Task waits for blockers: the status write refused it (a manager is not refused).
      else if (error instanceof AppError && error.errorId === TASK_BLOCKED)
        claims.push({
          number,
          success: false,
          reason: CLAIM_REFUSAL.blocked,
          blockedBy: JSON.parse(String(error.details?.blockedBy)) as TaskName[],
        });
      // The guarded write lost a race with another change to the same Task.
      else if (error instanceof AppError && error.code === "CONFLICT")
        claims.push({ number, success: false, reason: CLAIM_REFUSAL.changed });
      else throw error;
    }
  }
  return { tasks, claims };
}

export async function unclaimTask(
  ports: TaskBoardPorts,
  conversationId: string,
  member: Member,
  command: TaskCommand,
) {
  const task = await findTaskByNumber(ports.db, conversationId, command.number!);
  if (!task) throw new AppError("NOT_FOUND");
  if (task.ownerMemberId !== member.id) throw new AppError("ACCESS_DENIED");
  const { task: updated } = await ports.db.$transaction((tx) =>
    commitTaskChange(
      tx,
      member,
      task,
      {
        revision: command.expectedRevision ?? task.revision,
        ownerMemberId: memberId(member),
        status: { not: "done" },
      },
      withoutAssignee(task),
    ),
  );
  const view = await taskViewOf(ports.db, ports.reader, updated);
  await signalTaskChange(ports, updated, { view });
  return { tasks: [view] };
}
