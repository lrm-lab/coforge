import { announceMessageBestEffort } from "#src/server/conversations/conversation-activity.server";
import { conversationSignalScopes } from "#src/server/conversations/conversation-signal-scope.server";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import type { TaskCommand } from "@lrm/coforge-sdk/internal";
import { hostMessageId, type SelectedTask } from "./task-view.server";
import type { TaskBoardPorts, Member } from "./task-board-ports.server";
import { taskViewsOf } from "./task-relations.server";
import {
  announceTasks,
  publishAssignmentReceipt,
  publishDeliveries,
} from "./task-publication.server";

type CreatedTaskResult = Readonly<{
  tasks: SelectedTask[];
  sequences: number[];
  receipts: ReadonlyArray<{ id: string }>;
}>;

type TaskCreationScope = Readonly<{
  conversationId: string;
  workspaceId: string;
  channel: boolean;
  channelName: string | null;
}>;

/** Publishes the durable effects of a committed Task creation after its transaction settles. */
export async function publishCreatedTasks(
  ports: TaskBoardPorts,
  scope: TaskCreationScope,
  member: Member,
  command: TaskCommand,
  result: CreatedTaskResult,
): Promise<void> {
  // Committed Tasks survive notification/realtime/daemon failure through normal recovery.
  // Catch each effect immediately, including while delivery rows are still being read.
  const attempt = (effect: () => unknown) =>
    Promise.resolve()
      .then(effect)
      .catch(() => undefined);
  const scopes = await conversationSignalScopes(ports.db, scope.conversationId, scope.workspaceId);
  const signalScope = scopes.message;
  const effects: Promise<unknown>[] = [
    announceTasks(ports, scope, async () => scopes.task, {
      tasks: await taskViewsOf(ports.db, "people", result.tasks),
      publicationId: `${result.tasks[0]!.id}:task-created`,
    }),
  ];
  effects.push(
    ...result.tasks.flatMap((task, index) => [
      ...(member.userId
        ? [attempt(() => ports.dependencies.notifications?.notifyMessage(hostMessageId(task)))]
        : []),
      attempt(() =>
        announceMessageBestEffort(ports.db, ports.dependencies.realtime, {
          conversationId: scope.conversationId,
          messageId: hostMessageId(task),
          sequence: result.sequences[index]!,
          ...signalScope,
          ...(member.userId ? { senderUserId: member.userId } : {}),
        }),
      ),
    ]),
  );
  if (member.userId && ports.dependencies.publisher) {
    const messages = await ports.db.message.findMany({
      where: { id: { in: result.tasks.map((task) => hostMessageId(task)) } },
      include: {
        sender: MESSAGE_SENDER_SELECT,
        mentions: MESSAGE_MENTIONS_SELECT,
        deliveries: { include: { agent: { select: { computerId: true } } } },
      },
    });
    for (const message of messages) {
      const sender = agentMessageSender(message.sender);
      effects.push(
        publishDeliveries(
          ports,
          message,
          command.idempotencyKey,
          scope.channelName ? `#${scope.channelName}` : `@${sender.handle}`,
          sender,
        ),
      );
    }
  }
  await Promise.all(effects);
  // One delivery per Task's receipt, each its own daemon request: the receipt's id is stable
  // across retries, as the command's key is for a single one.
  await Promise.all(
    result.receipts.map((receipt) => publishAssignmentReceipt(ports, receipt.id, receipt.id)),
  );
}
