import { BROWSER_MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { TASK_CLAIM_BLOCKED_ACTIONS } from "@lrm/coforge-sdk/internal";
import {
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_PATTERN,
  type TaskClaimConflict,
  type TaskClaimResult,
  type TaskCommand,
  type TaskResult,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { channelThreadRootWhere } from "#src/server/db/message-anchor.server";
import { AppError } from "#src/lib/app-error";
import { noticeActor, noticeText } from "./task-notices.server";
import { createMessageTask } from "./sent-as-task.server";
import {
  storedTaskStatus,
  taskMember,
  taskSelection,
  taskView,
  type SelectedTask,
} from "./task-view.server";
import type {
  Transaction,
  TaskBoardPorts,
  Member,
  ConversationRef,
} from "./task-board-ports.server";
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
  messageNotFound: "message not found",
  ambiguousMessage: "message id matches more than one message",
  held: "already claimed",
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
    /** The refused Task's number, when the selector named its message rather than the number. */
    readonly number?: number,
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
    taskStatus: storedTaskStatus(task.status),
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
  const notFound: string[] = [CLAIM_REFUSAL.taskNotFound, CLAIM_REFUSAL.messageNotFound];
  throw new AppError(
    claims.every((claim) => notFound.includes(claim.reason ?? "")) ? "NOT_FOUND" : "CONFLICT",
  );
}

/** The top-level message `messageId` names (a full id or its short anchor) in the conversation. */
export async function findSourceMessage(
  tx: Transaction,
  conversationId: string,
  messageId: string,
) {
  // A short anchor (eight hex, or the dashed twelve-hex display form from #88) is the uuid range
  // it names, so the lookup stays an index range on the message id instead of reading every
  // top-level message in the conversation.
  const anchor = MESSAGE_ANCHOR.test(messageId) ? messageId : undefined;
  // Neither an anchor nor a whole id names no message; the id column would refuse the text.
  if (!anchor && !UUID_LIKE_PATTERN.test(messageId)) throw new AppError("NOT_FOUND");
  const messages = await tx.message.findMany({
    where: anchor
      ? channelThreadRootWhere(conversationId, anchor)
      : { conversationId, threadRootId: null, id: messageId },
    take: 2,
    select: {
      id: true,
      body: true,
      senderMemberId: true,
      mentions: BROWSER_MESSAGE_MENTIONS_SELECT,
    },
  });
  if (messages.length !== 1) throw new AppError(messages.length ? "CONFLICT" : "NOT_FOUND");
  return messages[0]!;
}

export async function convertOrClaim(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  command: TaskCommand,
  claim: boolean,
) {
  const { conversationId, workspaceId } = conversation;
  const task = await withNotices(ports, conversation, async (tx, notices) => {
    let existing = command.number
      ? await findTaskByNumber(tx, conversationId, command.number)
      : undefined;
    let message: { id: string; body: string } | undefined;
    if (!existing && command.messageId) {
      message = await findSourceMessage(tx, conversationId, command.messageId).catch(
        (error: unknown) => {
          if (!claim || !(error instanceof AppError)) throw error;
          throw new ClaimRefused(
            error.code === "CONFLICT"
              ? CLAIM_REFUSAL.ambiguousMessage
              : CLAIM_REFUSAL.messageNotFound,
          );
        },
      );
      existing =
        (await tx.task.findUnique({
          where: { messageId: message.id },
          select: taskSelection,
        })) ?? undefined;
    }
    if (!existing) {
      if (!message) {
        if (claim) throw new ClaimRefused(CLAIM_REFUSAL.taskNotFound);
        throw new AppError("NOT_FOUND");
      }
      existing = await createMessageTask(tx, { ...message, conversationId, workspaceId }, member);
      const [quoted] = await notices.quote([existing]);
      await notices.inConversation(noticeText.converted(noticeActor(member).displayName, quoted!));
    }
    if (!claim) return existing;
    if (
      existing.ownerMemberId === member.id &&
      existing.claimedAt !== null &&
      (existing.status === "in_progress" || existing.status === "in_review")
    ) {
      if (member.agentId && !existing.executionSessions[0]) {
        await ensureTaskExecutionSession(tx, existing, member.agentId);
        return tx.task.findUniqueOrThrow({
          where: { id: existing.id },
          select: taskSelection,
        });
      }
      return existing;
    }
    if (existing.status === "done" || existing.status === "closed")
      throw new ClaimRefused(`task is ${existing.status}`, undefined, existing.number);
    if (existing.ownerMemberId && existing.ownerMemberId !== member.id)
      throw new ClaimRefused(CLAIM_REFUSAL.held, claimConflict(existing), existing.number);
    const { task: claimed } = await commitTaskChange(
      tx,
      member,
      existing,
      { ownerMemberId: existing.ownerMemberId, status: existing.status },
      {
        ownerMemberId: member.id,
        claimedAt: new Date(),
        status: existing.status === "todo" ? "in_progress" : existing.status,
      },
    );
    // Claiming a Todo Task also moves it to In Progress; the claim notice says both.
    await notices.inThread(claimed, (quoted) =>
      noticeText.claimed(noticeActor(member).handle, quoted),
    );
    return claimed;
  });
  await signalTaskChange(ports, task);
  return { tasks: [taskView(task, ports.reader)] };
}

export async function claimTasks(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  command: TaskCommand,
): Promise<TaskResult> {
  const selectors: Array<{ number?: number; messageId?: string }> = [
    ...Array.from(
      new Set([...(command.numbers ?? []), ...(command.number ? [command.number] : [])]),
      (number) => ({ number }),
    ),
    ...Array.from(
      new Set([...(command.messageIds ?? []), ...(command.messageId ? [command.messageId] : [])]),
      (messageId) => ({ messageId }),
    ),
  ];
  // Every selector gets its own result row: a refused claim is an answer, not an error.
  const tasks: TaskView[] = [];
  const claims: TaskClaimResult[] = [];
  for (const selector of selectors) {
    try {
      const result = await convertOrClaim(
        ports,
        conversation,
        member,
        {
          ...command,
          numbers: undefined,
          messageIds: undefined,
          number: undefined,
          messageId: undefined,
          ...selector,
        },
        true,
      );
      const task = result.tasks[0]!;
      tasks.push(task);
      claims.push({ number: task.number, messageId: task.messageId ?? undefined, success: true });
    } catch (error) {
      if (error instanceof ClaimRefused)
        claims.push({
          ...selector,
          ...(error.number !== undefined && { number: error.number }),
          success: false,
          reason: error.reason,
          ...(error.conflict && { conflict: error.conflict }),
        });
      // The guarded write lost a race with another change to the same Task.
      else if (error instanceof AppError && error.code === "CONFLICT")
        claims.push({ ...selector, success: false, reason: CLAIM_REFUSAL.changed });
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
  if (task.status === "done") throw new AppError("CONFLICT");
  const { task: updated } = await ports.db.$transaction((tx) =>
    commitTaskChange(
      tx,
      member,
      task,
      {
        revision: command.expectedRevision ?? task.revision,
        ownerMemberId: member.id,
        status: { not: "done" },
      },
      withoutAssignee(task),
    ),
  );
  await signalTaskChange(ports, updated);
  return { tasks: [taskView(updated, ports.reader)] };
}
