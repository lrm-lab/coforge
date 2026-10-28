import type { ComponentPropsWithoutRef } from "react";

import { useConversationId } from "#src/features/conversations/conversation-id";
import { chipControl } from "#src/lib/chip-control";
import { cn } from "#src/lib/utils";
import { TaskNumberBadge, statusLabel } from "./task-status-icon";
import { useMissingTask, useNumberedTask } from "./use-conversation-tasks";

type TaskReferenceProps = ComponentPropsWithoutRef<"span"> & {
  number: number;
  /** Opens the Task's detail popup; absent, a known Task's badge is not a control. */
  onOpenTask?: (number: number) => void;
};

/**
 * A task reference in a message body. Inside a conversation it reads its own Task, so a Task's
 * change repaints its references alone; outside one, or for a number the conversation has no Task
 * for, it stays the words `task #N` (`children`). A number the conversation does not hold yet
 * already opens the Task while its read is under way, as Raft's does; only a number known to name
 * no Task is plain words.
 */
export function TaskReference({ number, onOpenTask, children, ...props }: TaskReferenceProps) {
  const conversationId = useConversationId();
  if (!conversationId) return <span {...props}>{children}</span>;
  return (
    <ConversationTaskReference
      {...props}
      conversationId={conversationId}
      number={number}
      onOpenTask={onOpenTask}
    >
      {children}
    </ConversationTaskReference>
  );
}

function ConversationTaskReference({
  conversationId,
  number,
  onOpenTask,
  children,
  ...props
}: TaskReferenceProps & { conversationId: string }) {
  const task = useNumberedTask(conversationId, number);
  const missing = useMissingTask(conversationId, number);
  const control = chipControl(onOpenTask && (() => onOpenTask(number)));
  if (missing) return <span {...props}>{children}</span>;
  return (
    <span
      {...props}
      {...control}
      // The ring is decorative, so the status is spelled out in the chip's name.
      aria-label={task ? `task #${number}, ${statusLabel(task.status)}` : `task #${number}`}
      data-task-status={task?.status}
      // A badge that opens its Task is a control: the pointer, hover and focus ring of one.
      className={cn(
        "inline-block rounded-md align-middle",
        control &&
          "cursor-pointer hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
      )}
    >
      {task ? (
        <TaskNumberBadge number={number} status={task.status} />
      ) : (
        // Not read yet: a plain block as wide as the badge (whose status icon and gap the even
        // padding stands in for), as Raft's, so the badge replaces it without moving the line.
        <span className="inline-flex items-center rounded-md px-3.5 py-0.5 text-xs font-semibold text-secondary ring-1 ring-secondary ring-inset">
          #{number}
        </span>
      )}
    </span>
  );
}
