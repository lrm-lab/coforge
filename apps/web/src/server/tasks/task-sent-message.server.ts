import { AppError } from "#src/lib/app-error";
import type { ConversationRef, TaskBoardPorts } from "./task-board-ports.server";
import { signalTaskChange } from "./task-publication.server";
import { taskSelection } from "./task-view.server";

/**
 * Announces the Task a sent message became (`sentMessageBecomesTask`). As on Raft it posts no
 * notice: the message itself shows as the Task in the stream.
 */
export async function announceSentMessageTask(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  messageId: string,
) {
  const task = await ports.db.task.findUnique({ where: { messageId }, select: taskSelection });
  if (!task || task.conversationId !== conversation.conversationId) throw new AppError("NOT_FOUND");
  await signalTaskChange(ports, task);
}
