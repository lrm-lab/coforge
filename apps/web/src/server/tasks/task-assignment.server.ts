import { assertCanAssignOther } from "./task-assignment-authority.server";
import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { assigneeMention, noticeActor, noticeAssignee, noticeText } from "./task-notices.server";
import { taskViewOf } from "./task-relations.server";
import type { TaskBoardPorts, Member, ConversationRef } from "./task-board-ports.server";
import { memberKey } from "./task-board-ports.server";
import {
  findTaskByNumber,
  assertExpectedRevision,
  commitTaskChange,
  withoutAssignee,
} from "./task-change.server";
import { withNotices, type NoticeWriter, type PostedNotice } from "./task-notice-posting.server";
import { signalTaskChange, publishAssignmentReceipt } from "./task-publication.server";
import { BOUND_ASSIGNEE, receiptAssignee, assigneeMember } from "./task-assignees.server";
import { indexedRequestId } from "./task-request-ids.server";
import { assignmentQueueNotes } from "./task-queue.server";
import { ownTaskScope } from "./task-list.server";
import type { TaskReader, SelectedTask } from "./task-view.server";
import type { Transaction } from "./task-board-ports.server";

/**
 * The assignment receipts of a write that gave Tasks an owner: one fixed-id notice in each
 * Task's thread, its mention and its one delivery to an Agent assignee that is not the actor.
 * Each carries the queue note `assign` gives it (task #716): a person's write is a direct
 * instruction — "do it first", never a number; an Agent's or the system's names the Task's
 * place in the assignee's queue. `receiptIds` aligns with `tasks`.
 */
export async function assignmentReceipts(
  tx: Transaction,
  notices: NoticeWriter,
  reader: TaskReader,
  scope: ConversationRef,
  member: Member,
  assignee: Member,
  tasks: readonly SelectedTask[],
  receiptIds: readonly string[],
  /** One handover line the assignment carries into its notice (`assign --reason`); absent for
   * every assignment nobody explained, which keeps its notice exactly as it was. */
  reason?: string,
): Promise<PostedNotice[]> {
  const queueNotes = assignee.agentId
    ? await assignmentQueueNotes(
        tx,
        reader,
        scope,
        member,
        assignee,
        tasks,
        ownTaskScope({ agentId: assignee.agentId }).conversations,
      )
    : undefined;
  const receipts: PostedNotice[] = [];
  for (const [index, task] of tasks.entries())
    receipts.push(
      await notices.receipt({
        id: receiptIds[index]!,
        task,
        body: (quoted) => ({
          body: noticeText.assigned(
            noticeActor(member).displayName,
            quoted,
            assigneeMention(assignee),
            queueNotes?.get(task.id),
            reason,
          ),
          system: {
            kind: "task.assigned",
            params: {
              actor: noticeActor(member),
              task: quoted,
              assignee: noticeAssignee(assignee),
              ...(reason ? { reason } : {}),
            },
          },
        }),
        assignee,
        actor: member,
      }),
    );
  return receipts;
}

export async function assignTask(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  command: TaskCommand,
): Promise<TaskResult> {
  const { conversationId, workspaceId } = conversation;
  if (
    command.assignee !== null &&
    !command.assignee?.match(/^@[a-z0-9][a-z0-9_-]{0,63}$/) &&
    !BOUND_ASSIGNEE.test(command.assignee ?? "")
  )
    throw new AppError("INVALID_INPUT");
  const receiptId = await indexedRequestId(
    `${memberKey(member)}:assign:${command.number}:${command.idempotencyKey}:assignment`,
    1,
  );
  const result = await withNotices(ports, conversation, async (tx, notices) => {
    const receipt = await tx.message.findUnique({ where: { id: receiptId } });
    if (receipt) {
      const task = await findTaskByNumber(tx, conversationId, command.number!);
      const assigned = await receiptAssignee(tx, receipt.id);
      return { task, receipt, assigneeHandle: assigned?.handle ?? null, changed: false };
    }
    const owner = command.assignee
      ? await assigneeMember(tx, conversationId, workspaceId, command.assignee)
      : null;
    if (command.assignee && !owner) throw new AppError("NOT_FOUND");
    const current = await findTaskByNumber(tx, conversationId, command.number!);
    if (!current) throw new AppError("NOT_FOUND");
    if (
      (owner && owner.id !== member.id) ||
      (current.ownerMemberId && current.ownerMemberId !== member.id)
    )
      await assertCanAssignOther(tx, workspaceId, member);
    assertExpectedRevision(current, command.expectedRevision);
    if (current.ownerMemberId === (owner?.id ?? null))
      return { task: current, receipt: null, assigneeHandle: null, changed: false };
    const { task } = await commitTaskChange(
      tx,
      member,
      current,
      { ownerMemberId: current.ownerMemberId },
      owner ? { ownerMemberId: owner.id, claimedAt: null } : withoutAssignee(current),
    );
    if (!owner) {
      await notices.inThread(task, (quoted) => ({
        body: noticeText.unassigned(noticeActor(member).displayName, quoted),
        system: { kind: "task.unassigned", params: { actor: noticeActor(member), task: quoted } },
      }));
      return { task, changed: true, receipt: null, assigneeHandle: null };
    }
    const [posted] = await assignmentReceipts(
      tx,
      notices,
      ports.reader,
      conversation,
      member,
      owner,
      [task],
      [receiptId],
      // Stored as one line, the way the CLI would have sent it (task #36).
      command.reason?.trim(),
    );
    return { task, changed: true, assigneeHandle: assigneeMention(owner), receipt: posted };
  });
  const { task, receipt } = result;
  const view = task && (await taskViewOf(ports.db, ports.reader, task));
  if (task && result.changed) await signalTaskChange(ports, task, { view: view ?? undefined });
  if (receipt && result.changed)
    await publishAssignmentReceipt(ports, receipt.id, command.idempotencyKey);
  return {
    tasks: view ? [view] : [],
    ...(receipt && {
      assignmentReceipts: [
        {
          messageId: receipt.id,
          content: receipt.body,
          assignee: result.assigneeHandle ?? command.assignee!,
          state: "assigned" as const,
        },
      ],
    }),
  };
}

/**
 * Clear a Task's owner, leaving it open for anyone to claim. A no-op on an already
 * unowned Task returns it unchanged; otherwise this is `assign` with no assignee,
 * minus the assignment receipt, since there is no one to notify.
 */
export async function unassignTask(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  command: TaskCommand,
): Promise<TaskResult> {
  const { conversationId, workspaceId } = conversation;
  const result = await withNotices(ports, conversation, async (tx, notices) => {
    const current = await findTaskByNumber(tx, conversationId, command.number!);
    if (!current) throw new AppError("NOT_FOUND");
    if (!current.ownerMemberId) return { task: current, changed: false };
    if (current.ownerMemberId !== member.id) await assertCanAssignOther(tx, workspaceId, member);
    assertExpectedRevision(current, command.expectedRevision);
    const { task } = await commitTaskChange(
      tx,
      member,
      current,
      { ownerMemberId: current.ownerMemberId },
      withoutAssignee(current),
    );
    await notices.inThread(task, (quoted) => ({
      body: noticeText.unassigned(noticeActor(member).displayName, quoted),
      system: { kind: "task.unassigned", params: { actor: noticeActor(member), task: quoted } },
    }));
    return { task, changed: true };
  });
  const view = await taskViewOf(ports.db, ports.reader, result.task);
  if (result.changed) await signalTaskChange(ports, result.task, { view });
  return { tasks: [view] };
}
