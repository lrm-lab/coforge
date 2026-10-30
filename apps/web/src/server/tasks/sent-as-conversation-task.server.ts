import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import { AppError } from "#src/lib/app-error";
import {
  MEMBER_SELECT,
  type ConversationRef,
  type TaskBoardPorts,
} from "./task-board-ports.server";
import { conversationSignalScopes } from "#src/server/conversations/conversation-signal-scope.server";
import { indexedRequestId } from "./task-request-ids.server";
import { announceTasks } from "./task-publication.server";
import { taskSelection, taskView } from "./task-view.server";
import {
  allocateTaskNumbers,
  insertConversationTask,
  sourceTitle,
} from "./task-conversation-creation.server";
import { BROWSER_MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";

/** The task a send spawns is made once per message: this id is its idempotency key. */
const sentTaskRequestId = (messageId: string) => indexedRequestId(`${messageId}:sent-as-task`, 1);

/**
 * "Send as task" under task conversations: the message is sent as any message is, and a task with
 * its own conversation is made from it in the same transaction, the message as its source. The
 * sender wrote the message, so no notice goes to its thread. The caller announces the task once
 * the send has committed (`announceSentTask`).
 */
export const sentMessageSpawnsTask: SentMessageHook = async (tx, message) => {
  if (message.threadRootId) throw new AppError("INVALID_INPUT");
  const [creator, stored] = await Promise.all([
    tx.conversationMember.findUniqueOrThrow({
      where: { id: message.senderMemberId },
      select: MEMBER_SELECT,
    }),
    tx.message.findUniqueOrThrow({
      where: { id: message.id },
      select: { body: true, mentions: BROWSER_MESSAGE_MENTIONS_SELECT },
    }),
  ]);
  const title = sourceTitle(stored);
  if (!title) throw new AppError("INVALID_INPUT");
  const scope = { conversationId: message.conversationId, workspaceId: message.workspaceId };
  await insertConversationTask(tx, scope, creator, {
    number: await allocateTaskNumbers(tx, message.conversationId, 1),
    title,
    assignee: null,
    requestId: await sentTaskRequestId(message.id),
    source: { id: message.id, senderMemberId: creator.id, ...stored },
  });
};

/** Announces the task a send spawned, if it spawned one: false when the message made none. */
export async function announceSpawnedTask(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  messageId: string,
) {
  const task = await ports.db.task.findFirst({
    where: {
      conversationId: conversation.conversationId,
      sourceMessageId: messageId,
      requestId: await sentTaskRequestId(messageId),
    },
    select: taskSelection,
  });
  if (!task) return false;
  const scopes = await conversationSignalScopes(
    ports.db,
    conversation.conversationId,
    conversation.workspaceId,
  );
  await announceTasks(ports, conversation, async () => scopes.task, {
    tasks: [taskView(task, "people")],
    publicationId: `${task.id}:task-created`,
  }).catch(() => undefined);
  return true;
}
