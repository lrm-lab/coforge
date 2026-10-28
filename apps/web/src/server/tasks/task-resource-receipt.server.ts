import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { taskSelection } from "./task-view.server";
import {
  REMINDER_SYNC_MESSAGE_TYPE,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeReminderSync,
  type TaskCommand,
  type TaskResult,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";
import { MAX_ACTIVE_REMINDERS } from "#src/server/reminders/reminders.server";
import { taskView } from "./task-view.server";
import type { TaskBoardPorts, Member } from "./task-board-ports.server";
import { commitTaskChange } from "./task-change.server";
import { signalTaskChange } from "./task-publication.server";
import { requireManager } from "./task-assignees.server";

export async function recordResourceReceipt(
  ports: TaskBoardPorts,
  conversationId: string,
  workspaceId: string,
  member: Member,
  command: TaskCommand,
): Promise<TaskResult> {
  const receipt = command.receipt;
  if (
    !receipt ||
    Object.values(receipt).some((value) => typeof value !== "string" || !value.trim()) ||
    !receipt.teardownOwner.match(/^@[a-z0-9][a-z0-9_-]{0,63}$/)
  )
    throw new AppError("INVALID_INPUT");
  const fireAt = new Date(receipt.expiry);
  if (!Number.isFinite(fireAt.getTime())) throw new AppError("INVALID_INPUT");

  const result = await ports.db.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: {
        conversationId_number: { conversationId, number: command.number! },
      },
      select: {
        ...taskSelection,
        resourceExpiryFollowupId: true,
      },
    });
    if (!task) throw new AppError("NOT_FOUND");
    if (!task.createsResource) throw new AppError("CONFLICT");
    if (task.ownerMemberId !== member.id) await requireManager(tx, workspaceId, member);
    const teardownOwner = await tx.agent.findFirst({
      where: {
        workspaceId,
        name: receipt.teardownOwner.slice(1),
        computerId: { not: null },
        ...ACTIVE_AGENT_WHERE,
        conversations: { some: { conversationId } },
      },
      select: { id: true, computerId: true, name: true },
    });
    if (!teardownOwner?.computerId) throw new AppError("NOT_FOUND");
    await tx.$queryRaw`SELECT "id" FROM "agents" WHERE "id" = ${teardownOwner.id}::uuid FOR UPDATE`;
    const workspaceComputer = await tx.workspaceComputer.findUnique({
      where: {
        workspaceId_computerId: {
          workspaceId,
          computerId: teardownOwner.computerId,
        },
      },
      select: { computerId: true },
    });
    if (!workspaceComputer) throw new AppError("ACCESS_DENIED");
    if (task.resourceExpiryFollowupId) {
      const recorded = taskView(task).resourceReceipt;
      if (
        !recorded ||
        Object.entries(receipt).some(([key, value]) => Reflect.get(recorded, key) !== value)
      )
        throw new AppError("CONFLICT");
      const reminder = await tx.reminder.findUniqueOrThrow({
        where: { id: task.resourceExpiryFollowupId },
      });
      return { task, reminder, owner: teardownOwner };
    }
    if (fireAt <= new Date()) throw new AppError("INVALID_INPUT");
    const activeReminders = await tx.reminder.count({
      where: {
        workspaceId,
        ownerAgentId: teardownOwner.id,
        status: "scheduled",
      },
    });
    if (activeReminders >= MAX_ACTIVE_REMINDERS) throw new AppError("CONFLICT");
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        channelName: true,
        members: {
          where: { userId: { not: null } },
          take: 1,
          select: { user: { select: { username: true } } },
        },
      },
    });
    const baseTarget = conversation.channelName
      ? `#${conversation.channelName}`
      : `@${conversation.members[0]?.user?.username}`;
    if (baseTarget.endsWith("undefined")) throw new AppError("INTERNAL_ERROR");
    const reminder = await tx.reminder.create({
      data: {
        workspaceId,
        ownerAgentId: teardownOwner.id,
        computerId: teardownOwner.computerId,
        title: `Expire resource from task #${task.number}: ${receipt.object}`,
        target: `${baseTarget}:${task.messageId}`,
        messageId: task.messageId,
        fireAt,
        events: {
          create: {
            workspace: { connect: { id: workspaceId } },
            type: "created",
            title: `Expire resource from task #${task.number}`,
            scheduledFor: fireAt,
          },
        },
      },
    });
    const { task: updated } = await commitTaskChange(
      tx,
      member,
      task,
      { resourceExpiryFollowupId: null },
      {
        resourceReceipt: receipt,
        resourceReceiptRecordedAt: new Date(),
        resourceTeardownOwnerAgentId: teardownOwner.id,
        resourceExpiryFollowupId: reminder.id,
      },
    );
    return { task: updated, reminder, owner: teardownOwner };
  });
  await signalTaskChange(ports, result.task);
  if (ports.dependencies.publisher)
    try {
      await ports.dependencies.publisher.publish(
        daemonControlChannel(workspaceId, result.reminder.computerId),
        encodeReminderSync({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: command.idempotencyKey,
          workspaceId,
          computerId: result.reminder.computerId,
          agentId: result.owner.id,
          operation: "upsert",
          jobs: [
            {
              reminderId: result.reminder.id,
              ownerAgentId: result.owner.id,
              version: result.reminder.version,
              title: result.reminder.title,
              target: result.reminder.target,
              messageId: result.reminder.messageId,
              fireAt: result.reminder.fireAt.toISOString(),
            },
          ],
          messageType: REMINDER_SYNC_MESSAGE_TYPE,
        }),
      );
    } catch {
      // Reminder snapshot reconciliation repairs a missed upsert.
    }
  return {
    tasks: [taskView(result.task, ports.reader)],
    resourceFollowup: {
      id: result.reminder.id,
      ownerAgentId: result.owner.id,
      owner: `@${result.owner.name}`,
      fireAt: result.reminder.fireAt.toISOString(),
      messageId: result.reminder.messageId,
      conversationId,
    },
  };
}
