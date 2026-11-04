import { assertCanAssignOther } from "./task-assignment-authority.server";
import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { assigneeMention, noticeActor, noticeText } from "./task-notices.server";
import { taskViewOf } from "./task-relations.server";
import type { TaskBoardPorts, Member, ConversationRef } from "./task-board-ports.server";
import { memberId } from "./task-board-ports.server";
import {
  findTaskByNumber,
  assertExpectedRevision,
  commitTaskChange,
  withoutAssignee,
} from "./task-change.server";
import { withNotices } from "./task-notice-posting.server";
import { signalTaskChange, publishAssignmentReceipt } from "./task-publication.server";
import { BOUND_ASSIGNEE, receiptAssignee, assigneeMember } from "./task-assignees.server";
import { indexedRequestId } from "./task-request-ids.server";

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
    `${memberId(member)}:assign:${command.number}:${command.idempotencyKey}:assignment`,
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
    return {
      task,
      changed: true,
      assigneeHandle: assigneeMention(owner),
      receipt: await notices.receipt({
        id: receiptId,
        task,
        body: (quoted) => ({
          body: noticeText.assigned(
            noticeActor(member).displayName,
            quoted,
            assigneeMention(owner),
          ),
          system: {
            kind: "task.assigned",
            params: {
              actor: noticeActor(member),
              task: quoted,
              assignee: {
                memberId: owner.id,
                handle: assigneeMention(owner).slice(1),
                displayName: assigneeMention(owner).slice(1),
              },
            },
          },
        }),
        assignee: owner,
        actor: member,
      }),
    };
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
