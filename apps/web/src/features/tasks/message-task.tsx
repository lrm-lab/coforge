import { useConversationId } from "#src/features/conversations/conversation-id";
import { TaskChip } from "./task-chip";
import { useMessageTask } from "./use-conversation-tasks";

type MessageTaskProps = {
  messageId: string;
  /** Opens the Task's popup; absent, the chip is not a control. */
  onOpenTask?: (number: number) => void;
};

/**
 * The Task a message became, or (task conversations) was made from, under the message: the same
 * chip a message's words name a Task with, its status icon and title, with who holds it, what it
 * waits on and its sub-tasks in its peek (task #449, Frank 11-04). Inside a conversation it reads
 * that one Task, so a Task's change repaints its own message's chip and no other row; outside one
 * it shows nothing.
 */
export function MessageTask({ messageId, onOpenTask }: MessageTaskProps) {
  const conversationId = useConversationId();
  return conversationId ? (
    <ConversationMessageTask
      conversationId={conversationId}
      messageId={messageId}
      onOpenTask={onOpenTask}
    />
  ) : null;
}

function ConversationMessageTask({
  conversationId,
  messageId,
  onOpenTask,
}: MessageTaskProps & { conversationId: string }) {
  const task = useMessageTask(conversationId, messageId);
  if (!task) return null;
  return (
    // In the message's own type scale, so it is the size of the chips in its words and follows
    // Settings → Message font size with them.
    <span
      data-message-task={task.number}
      className="message-text mt-1 inline-flex max-w-full text-md"
    >
      <TaskChip task={task} onPress={onOpenTask && (() => onOpenTask(task.number))} />
    </span>
  );
}
