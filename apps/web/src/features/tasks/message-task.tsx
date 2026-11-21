import { MessageChatCircle } from "@untitledui/icons";
import { useRef } from "react";
import { Button as AriaButton } from "react-aria-components";

import { DELETED_AGENT_NAME_CLASS } from "#src/features/agents/deleted-agent";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useConversationId } from "#src/features/conversations/conversation-id";
import { rememberSharedRect } from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConversationTask } from "./conversation-task-subset";
import { priorityLabel } from "./task-history-more";
import { TaskPriorityIcon } from "./task-priority-icon";
import { TaskStatusBadge, TaskStatusIcon } from "./task-status-icon";
import { useMessageTasks } from "./use-conversation-tasks";

type MessageTaskProps = {
  messageId: string;
  onOpenTask?: (number: number) => void;
};

export function MessageTask({ messageId, onOpenTask }: MessageTaskProps) {
  const conversationId = useConversationId();
  return conversationId ? (
    <ConversationMessageTasks
      conversationId={conversationId}
      messageId={messageId}
      onOpenTask={onOpenTask}
    />
  ) : null;
}

function ConversationMessageTasks({
  conversationId,
  messageId,
  onOpenTask,
}: MessageTaskProps & { conversationId: string }) {
  const tasks = useMessageTasks(conversationId, messageId);
  if (!tasks?.length) return null;
  return (
    <div className="mt-1.5 w-full overflow-hidden rounded-lg border border-secondary bg-primary divide-y divide-secondary">
      {tasks.map((task) => (
        <MessageTaskRow key={task.id} task={task} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

function MessageTaskRow({
  task,
  onOpenTask,
}: {
  task: ConversationTask;
  onOpenTask?: (number: number) => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const owner = task.owner;
  const replyCount = task.replyCount ?? 0;
  const showPriority = Boolean(task.priority && task.priority !== "none");
  const content = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
        {showPriority && (
          <span className="hidden size-3.5 shrink-0 items-center sm:flex">
            <TaskPriorityIcon
              priority={task.priority!}
              label={m.tasks_priority_mark({ priority: priorityLabel(task.priority!) })}
              className="size-3.5"
            />
          </span>
        )}
        <span className="shrink-0 text-xs text-tertiary tabular-nums sm:w-9">#{task.number}</span>
        <span className="inline-flex shrink-0 sm:hidden" data-task-status={task.status}>
          <TaskStatusIcon status={task.status} />
        </span>
        <span ref={titleRef} className="min-w-0 truncate text-sm font-medium text-primary">
          {task.title}
        </span>
        {replyCount > 0 && (
          <span
            aria-label={m.task_card_replies({ count: replyCount })}
            className="inline-flex shrink-0 items-center gap-1 text-xs text-tertiary tabular-nums"
          >
            <MessageChatCircle aria-hidden="true" className="size-3.5" />
            {replyCount}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2 sm:gap-2.5">
        {owner && (
          <span className="flex shrink-0 items-center gap-1.5">
            <ActorAvatar
              presence={false}
              size="xs"
              name={owner.name}
              alt=""
              src={owner.avatarUrl ?? undefined}
              deleted={owner.deleted}
              {...(owner.kind === "agent" ? { agentId: owner.id } : { userId: owner.id })}
            />
            <span
              className={cn(
                "hidden max-w-28 truncate text-xs sm:inline",
                owner.deleted ? DELETED_AGENT_NAME_CLASS : "text-secondary",
              )}
            >
              {owner.name}
            </span>
          </span>
        )}
        <span className="hidden sm:inline-flex">
          <TaskStatusBadge status={task.status} />
        </span>
      </span>
    </>
  );

  if (!onOpenTask) {
    return (
      <div
        data-message-task={task.number}
        className="flex min-h-10 w-full items-center justify-between gap-2 px-3 py-1.5 sm:gap-3 sm:px-3.5"
      >
        {content}
      </div>
    );
  }

  return (
    <AriaButton
      ref={rowRef}
      data-message-task={task.number}
      onPress={() => {
        if (rowRef.current) rememberSharedRect(`task-frame:${task.number}`, rowRef.current);
        if (titleRef.current) rememberSharedRect(`task-title:${task.number}`, titleRef.current);
        onOpenTask(task.number);
      }}
      className={cn(
        "flex min-h-10 w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors any-pointer-coarse:min-h-11 sm:gap-3 sm:px-3.5",
        "hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
      )}
    >
      {content}
    </AriaButton>
  );
}
