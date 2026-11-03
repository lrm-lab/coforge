import { useConversationId } from "#src/features/conversations/conversation-id";
import { chipControl } from "#src/lib/chip-control";
import { TaskBadge } from "./task-board";
import { useMessageTask } from "./use-conversation-tasks";

type MessageTaskProps = {
  messageId: string;
  /** Opens the Task's popup; absent, the badge is not a control. */
  onOpenTask?: (number: number) => void;
};

/**
 * The Task a message became, or (task conversations) was made from, under the message: its
 * number, status and owner, opening its popup when pressed. Inside a conversation it reads that one
 * Task, so a Task's change repaints its own message's badge and no other row; outside one it shows
 * nothing.
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
  const control = chipControl(onOpenTask && (() => onOpenTask(task.number)));
  if (!control) return <TaskBadge task={task} />;
  return (
    <span
      {...control}
      data-message-task={task.number}
      // A badge that opens its Task is a control: the pointer, hover and focus ring of one.
      className="cursor-pointer rounded-md hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <TaskBadge task={task} />
    </span>
  );
}
