import type { TaskView } from "@lrm/coforge-sdk/internal";
import { AgentDeliveryPublisher } from "#src/server/conversations/agent-delivery.server";
import { MentionDeliveryIssuer } from "#src/server/conversations/mention-deliveries.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import {
  conversationSignalScopes,
  type MessageSignalScope,
} from "#src/server/conversations/conversation-signal-scope.server";
import {
  MESSAGE_MENTIONS_SELECT,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
  type AgentMessageSender,
} from "#src/server/conversations/sender-display.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import {
  conversationTarget,
  deliveryTarget,
  TARGET_CONVERSATION_SELECT,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { taskView, type SelectedTask } from "./task-view.server";
import type { TaskBoardPorts } from "./task-board-ports.server";

/** Push a committed message to every Agent it was delivered to. Failures never surface. */
export async function publishDeliveries(
  ports: TaskBoardPorts,
  message: {
    id: string;
    workspaceId: string;
    conversationId: string;
    sequence: number;
    createdAt: Date;
    body: string;
    mentions: readonly MessageMentionRef[];
    deliveries: Array<{
      deliveryId: string;
      agentId: string;
      taskExecutionSessionId: string | null;
      agent: { computerId: string | null };
    }>;
  },
  requestId: string,
  target: string,
  sender: AgentMessageSender,
) {
  const publisher = ports.dependencies.publisher;
  if (!publisher) return;
  // A Task delivery is directed at its Agent: a personal wake, tracked like a mention. Failures
  // never surface.
  await new AgentDeliveryPublisher(
    publisher,
    new MentionDeliveryIssuer(new PrismaMentionDeliveryRepository(ports.db)),
  ).publish(
    message.workspaceId,
    message.deliveries.map((delivery) => ({
      computerId: delivery.agent.computerId,
      requestId,
      conversationId: message.conversationId,
      agentId: delivery.agentId,
      messageId: message.id,
      deliveryId: delivery.deliveryId,
      sequence: message.sequence,
      createdAtMs: message.createdAt.getTime(),
      body: message.body,
      mentions: message.mentions,
      target,
      latestSenderKind: sender.kind,
      latestSenderHandle: sender.handle,
      latestSenderDescription: sender.description,
      mentionsAgent: true,
      ...(delivery.taskExecutionSessionId
        ? { taskExecutionSessionId: delivery.taskExecutionSessionId }
        : {}),
    })),
  );
}

/**
 * Pushes a message of a task's own conversation to the pages open on it, and to the Agents it was
 * delivered to, each by the task it names (`#channel:#N`, from that Agent's seat; a directed wake,
 * like a Task delivery). The conversation is hidden: no sidebar or badge hears of it, and a page
 * can subscribe only as far as the board lets it read (`authorizeConversationRealtime`).
 */
export async function publishTaskConversationMessage(
  ports: TaskBoardPorts,
  messageId: string,
  requestId: string,
) {
  const message = await ports.db.message.findUniqueOrThrow({
    where: { id: messageId },
    include: {
      conversation: { select: TARGET_CONVERSATION_SELECT },
      sender: MESSAGE_SENDER_SELECT,
      mentions: MESSAGE_MENTIONS_SELECT,
      deliveries: { include: { agent: { select: { computerId: true } } } },
    },
  });
  await ports.dependencies.realtime
    ?.messageAvailable({
      conversationId: message.conversationId,
      messageId: message.id,
      sequence: message.sequence,
      workspaceId: message.workspaceId,
    })
    .catch(() => undefined);
  if (!ports.dependencies.publisher) return;
  const sender = agentMessageSender(message.sender);
  await Promise.allSettled(
    message.deliveries.map(async (delivery) => {
      const targetOf = await directTargets(ports.db, message.workspaceId, delivery.agentId, [
        message.conversation,
      ]);
      await publishDeliveries(
        ports,
        { ...message, deliveries: [delivery] },
        requestId,
        conversationTarget(message.conversation, targetOf),
        sender,
      );
    }),
  );
}

export async function publishAssignmentReceipt(
  ports: TaskBoardPorts,
  messageId: string,
  requestId: string,
) {
  const message = await ports.db.message.findUniqueOrThrow({
    where: { id: messageId },
    include: {
      conversation: {
        select: {
          channelName: true,
          kind: true,
          members: {
            where: { userId: { not: null } },
            take: 1,
            select: { user: { select: { username: true } } },
          },
        },
      },
      mentions: MESSAGE_MENTIONS_SELECT,
      deliveries: { include: { agent: { select: { computerId: true } } } },
    },
  });
  if (message.conversation.kind === "task_thread")
    return publishTaskConversationMessage(ports, message.id, requestId);
  // Receipts count no unread: signal only the conversation, never sidebar badges. Human
  // assignees receive a Mentions Activity item and activity.changed.v1.
  const assignedPerson = message.mentions.find((mention) => mention.kind === "user")?.actorId;
  // A failed notification never rolls back or misreports a committed assignment.
  await Promise.allSettled([
    Promise.resolve().then(() =>
      ports.dependencies.realtime?.messageAvailable({
        conversationId: message.conversationId,
        messageId: message.id,
        sequence: message.sequence,
        ...(message.threadRootId && { threadRootId: message.threadRootId }),
      }),
    ),
    Promise.resolve().then(() =>
      assignedPerson
        ? ports.dependencies.realtime?.activityChanged?.({
            workspaceId: message.workspaceId,
            userId: assignedPerson,
          })
        : undefined,
    ),
    Promise.resolve().then(() => ports.dependencies.notifications?.notifyMessage(message.id)),
    publishDeliveries(
      ports,
      message,
      requestId,
      deliveryTarget(
        message.conversation.channelName
          ? `#${message.conversation.channelName}`
          : `@${message.conversation.members[0]!.user!.username}`,
        message.threadRootId,
      ),
      agentMessageSender(null),
    ),
  ]);
}

export async function signalTaskChange(ports: TaskBoardPorts, task: SelectedTask) {
  const realtime = ports.dependencies.realtime;
  if (!realtime) return;
  try {
    const scopes = await conversationSignalScopes(ports.db, task.conversationId, task.workspaceId);
    await Promise.allSettled([
      // A Task's metadata change is a top-level message signal; one with no message has none.
      Promise.resolve().then(() =>
        task.messageId && task.message
          ? realtime.messageAvailable({
              conversationId: task.conversationId,
              messageId: task.messageId,
              sequence: task.message.sequence,
              ...scopes.message,
              publicationId: `${task.messageId}:task:${task.revision}`,
            })
          : undefined,
      ),
      announceTasks(ports, task, async () => scopes.task, {
        tasks: [taskView(task, "people")],
        publicationId: `${task.id}:task-changed:${task.revision}`,
      }),
    ]);
  } catch {
    // PostgreSQL is canonical; normal reconciliation repairs a missed metadata event.
  }
}

/**
 * Publish changed Task copies or deleted ids to route scopes (none means no publication).
 * Use a key distinct from message signals; Centrifugo deduplicates keys. Never fail the write,
 * including if the route read fails.
 */
export async function announceTasks(
  ports: TaskBoardPorts,
  conversation: { conversationId: string; workspaceId: string },
  route: () => Promise<MessageSignalScope | undefined>,
  change: { tasks?: TaskView[]; deleted?: string[]; publicationId: string },
) {
  const taskChanged = ports.dependencies.realtime?.taskChanged?.bind(ports.dependencies.realtime);
  if (!taskChanged) return;
  try {
    const scope = await route();
    if (!scope) return;
    // The whole scope, so a new way of routing reaches the port without another field copied here.
    await taskChanged({
      ...scope,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.conversationId,
      tasks: change.tasks ?? [],
      deleted: change.deleted ?? [],
      publicationId: change.publicationId,
    });
  } catch {
    // PostgreSQL is canonical: a page that missed it shows the change on its next read.
  }
}
