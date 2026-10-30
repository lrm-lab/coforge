import { isAppError } from "#src/lib/app-error";
import { TASK_ASSIGNMENT_MANAGER_REQUIRED } from "./task-assignment";
import { useTaskAssignmentAccess } from "./use-task-assignment-access";
import { AssigneeMenu } from "./task-assignee-menu";
import { TaskFieldTrigger as EditableTrigger } from "./task-field-trigger";
import type { TaskCommand, TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronDown,
  ChevronUp,
  DotsHorizontal as MoreHorizontal,
  XClose,
} from "@untitledui/icons";
import { useState, type ComponentProps, type ReactNode } from "react";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { StatusBadge, TaskHistory, type TimelineNames } from "./task-history";
import { TaskPerson } from "./task-owner";
import { getTaskMoveCommand, taskStatusOptions } from "./task-move";
import { executeTask } from "./tasks.functions";
import { TaskDeleteDialog, taskDeleteMenuItem, useCanDeleteTask } from "./task-delete";
import { TaskSourceLink } from "./task-source";
import { ownsDiscussion, taskFollowMenuItem, useTaskFollow } from "./task-follow";
import { useConversationTaskWrites } from "./use-conversation-tasks";
import { statusLabel, TASK_STATUS_COLOR, type TaskControls } from "./task-workflow";

type DetailCommand = Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { number: number };

export function TaskDetailMenu({
  task,
  moves = [],
  onOpenDetails,
  ...dialog
}: Omit<TaskDetailDialogProps, "open" | "onOpenChange" | "thread"> & {
  /** Board and list moves, listed under "Move to". */
  moves?: TaskControls["moves"];
  /** Opens the caller's own Task popup for "View details" — the conversation's, which also
   * shows the Task's thread. Without it the menu opens a popup of the Task alone. */
  onOpenDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canDelete = useCanDeleteTask(task, dialog.currentMemberId);
  return (
    <>
      <Dropdown.Root>
        <ButtonUtility
          tooltip={m.tasks_more_actions({ number: String(task.number) })}
          icon={MoreHorizontal}
          size="xs"
          color="tertiary"
        />
        <Dropdown.Popover placement="bottom end" className="w-48">
          <Dropdown.Menu
            onAction={(key) => {
              if (key === "details") return onOpenDetails ? onOpenDetails() : setOpen(true);
              if (key === "delete") return setDeleting(true);
              moves.find((move) => move.status === key)?.onMove();
            }}
          >
            <Dropdown.Section>
              <Dropdown.Item id="details" label={m.tasks_view_details()} />
            </Dropdown.Section>
            {moves.length > 0 && (
              <Dropdown.Section className="border-t border-secondary pt-1">
                <Dropdown.SectionHeader className="px-4 pt-1.5 pb-1 text-xs font-medium text-tertiary">
                  {m.tasks_move_to()}
                </Dropdown.SectionHeader>
                {moves.map(({ status }) => (
                  <Dropdown.Item key={status} id={status} textValue={statusLabel(status)}>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`size-2 shrink-0 rounded-full ${TASK_STATUS_COLOR[status].dot}`}
                      />
                      {statusLabel(status)}
                    </span>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            )}
            {canDelete && (
              <Dropdown.Section className="border-t border-secondary pt-1">
                {taskDeleteMenuItem()}
              </Dropdown.Section>
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <TaskDeleteDialog
        task={task}
        open={deleting}
        onOpenChange={setDeleting}
        onCommand={dialog.onCommand}
      />
      {!onOpenDetails && (
        <TaskDetailDialog task={task} open={open} onOpenChange={setOpen} {...dialog} />
      )}
    </>
  );
}

type TaskDetailDialogProps = {
  task: TaskView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs a mutation through the caller's task command (which owns the conversation's task
   * list). Absent where no such owner is threaded in — a task-reference chip inside the message
   * stream, say — and the dialog then runs the command itself and refreshes that list. */
  onCommand?: (command: DetailCommand) => Promise<void>;
  /** The Task was deleted from the popup's More menu; the popup closes either way. */
  onDeleted?: () => void;
  /** `#channel` or the direct conversation's name, shown above the task number. */
  conversationName?: string;
  /** The conversation's members, which name people in the history and offer who to assign.
   * Without them the assignee is shown but cannot be changed. */
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  thread?: (taskSection: ReactNode) => ReactNode;
  /** Leaves the popup for a message in the conversation's chat; where absent, a Task made from
   * someone's message does not link it. */
  onOpenSource?: (messageId: string) => void;
};

/**
 * The Task popup: title, change history, status/assignee controls and — where the caller owns
 * the conversation — the Task message's thread, which `thread` renders around the task section.
 */
export function TaskDetailDialog({
  task,
  open,
  onOpenChange,
  onCommand,
  onDeleted,
  conversationName,
  members,
  currentMemberId,
  thread,
  onOpenSource,
}: TaskDetailDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const canDelete = useCanDeleteTask(task, currentMemberId);
  // A Task followed for its own conversation; a message's thread keeps the thread's own follow.
  const follow = useTaskFollow(task, open && Boolean(thread) && ownsDiscussion(task));
  const section = (
    <TaskSection
      task={task}
      onCommand={onCommand}
      members={members}
      currentMemberId={currentMemberId}
      source={
        task.sourceMessageId && onOpenSource && conversationName
          ? {
              conversationId: task.conversationId,
              messageId: task.sourceMessageId,
              channel: conversationName,
              onOpen: () => onOpenSource(task.sourceMessageId!),
            }
          : undefined
      }
    />
  );
  return (
    <>
      <TaskPopupOverlay isOpen={open} onOpenChange={onOpenChange}>
        <Modal
          className={cn(
            // On a phone the thread scrolls, never the sheet (the shared Modal scrolls there).
            "flex h-full w-full flex-col overflow-hidden rounded-none max-sm:overflow-hidden max-sm:shadow-none",
            // With a thread the popup is a workspace; without one it only wraps the task.
            thread
              ? "sm:h-[min(92vh,64rem)] sm:w-[min(60rem,calc(100vw-2rem))]"
              : "sm:h-auto sm:w-[min(40rem,calc(100vw-2rem))]",
          )}
        >
          <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-3 border-b border-secondary py-3 pr-3 pl-4 sm:pl-6">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-tertiary">{conversationName}</div>
                <Heading
                  slot="title"
                  level={2}
                  className="truncate text-md font-semibold text-primary"
                >
                  {m.tasks_details_title({ number: String(task.number) })}
                </Heading>
              </div>
              {(follow || canDelete) && (
                <Dropdown.Root>
                  <ButtonUtility
                    tooltip={m.tasks_more_actions({ number: String(task.number) })}
                    icon={MoreHorizontal}
                    size="sm"
                    color="tertiary"
                  />
                  <Dropdown.Popover placement="bottom end" className="w-52">
                    <Dropdown.Menu onAction={(key) => key === "delete" && setDeleting(true)}>
                      {follow && taskFollowMenuItem(follow)}
                      {canDelete && taskDeleteMenuItem()}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.Root>
              )}
              <ButtonUtility
                icon={XClose}
                size="sm"
                color="tertiary"
                aria-label={m.tasks_close()}
                onClick={() => onOpenChange(false)}
              />
            </div>
            {thread ? (
              <div className="flex min-h-0 flex-1 flex-col">{thread(section)}</div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">{section}</div>
            )}
          </Dialog>
        </Modal>
      </TaskPopupOverlay>
      <TaskDeleteDialog
        task={task}
        open={deleting}
        onOpenChange={setDeleting}
        onCommand={onCommand}
        onDeleted={() => {
          onOpenChange(false);
          onDeleted?.();
        }}
      />
    </>
  );
}

/**
 * The popup's overlay. A phone shows the popup as a full-screen sheet over the visual viewport the
 * overlay follows: with the keyboard up, the header stays at the top and the composer sits right
 * above the keyboard.
 */
function TaskPopupOverlay(
  props: Pick<ComponentProps<typeof ModalOverlay>, "isOpen" | "onOpenChange" | "children">,
) {
  return (
    <ModalOverlay
      {...props}
      isDismissable
      className="max-sm:items-stretch max-sm:px-0 max-sm:[--modal-pb:0px] max-sm:[--modal-pt:0px]"
    />
  );
}

function TaskSection({
  task,
  onCommand,
  members,
  currentMemberId,
  source,
}: {
  task: TaskView;
  onCommand?: (command: DetailCommand) => Promise<void>;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  /** The message the Task was made from, as a link back to it. */
  source?: ComponentProps<typeof TaskSourceLink>;
}) {
  const execute = useServerFn(executeTask);
  const writeTasks = useConversationTaskWrites();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"permission" | "other" | null>(null);
  const access = useTaskAssignmentAccess();
  const canEditAssignment =
    access.canAssignOthers || !task.owner || task.owner.memberId === currentMemberId;
  const assignableMembers = access.canAssignOthers
    ? members
    : members?.filter((member) => member.kind === "user" && member.id === access.userId);
  // Keyed by revision: every change bumps it, so the history reloads whenever the Task changes
  // and an older response can never overwrite a newer one.
  const history = useQuery({
    queryKey: ["task", "history", task.conversationId, task.number, task.revision],
    queryFn: async () => {
      const result = await execute({
        data: {
          operation: "history",
          idempotencyKey: crypto.randomUUID(),
          conversationId: task.conversationId,
          number: task.number,
        },
      });
      return result.history ?? [];
    },
    placeholderData: (previous) => previous,
  });

  async function run(command: DetailCommand) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (onCommand) {
        await onCommand(command);
      } else {
        // No external owner: run it here, then write the server's copies into the conversation's
        // Tasks, so the chip, the popup and the Tasks tab show the change without reading again.
        const result = await execute({
          data: {
            ...command,
            idempotencyKey: crypto.randomUUID(),
            conversationId: task.conversationId,
          },
        });
        writeTasks(task.conversationId, [{ tasks: result.tasks, deleted: [] }]);
      }
    } catch (failure) {
      const permission =
        isAppError(failure) && failure.errorId === TASK_ASSIGNMENT_MANAGER_REQUIRED;
      setError(permission ? "permission" : "other");
      if (permission) void access.refetch();
    } finally {
      setPending(false);
    }
  }

  const creator = task.creator;
  // History names its actor by handle and an assignee by User/Agent id: the conversation's
  // members first, then the Task's own owner and creator, who may have left the conversation.
  const people = [
    ...(members ?? []).map(({ kind, id, handle, label }) => ({ kind, id, handle, name: label })),
    ...[task.owner, creator].filter((person) => person !== null),
  ];
  const unknown = m.tasks_history_unknown_member();
  const names: TimelineNames = {
    actor: (type, handle) => {
      const known = people.find((person) => person.kind === type && person.handle === handle);
      if (known) return known.name;
      // A person who has left the conversation is no longer listed, and their username is not a
      // name to read; an Agent's handle is its name.
      return type === "user" ? unknown : (handle ?? unknown);
    },
    assignee: (kind, id) =>
      people.find((person) => person.kind === kind && person.id === id)?.name ?? unknown,
  };

  return (
    // A phone keeps this fixed block short so the thread under it gets the screen: a two-line
    // title, Status and Owner side by side with their labels inline, and the creator left to the
    // History's "Created task" entry.
    <section className="flex flex-col gap-3 border-b border-secondary px-4 py-3 sm:gap-5 sm:px-6 sm:py-5">
      <h3 className="line-clamp-2 text-md font-semibold break-words text-primary sm:line-clamp-3 sm:text-lg">
        {task.title}
      </h3>

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:grid sm:grid-cols-3 sm:gap-x-8 sm:gap-y-4">
        <TaskField label={m.tasks_overview_status()}>
          <StatusMenu
            task={task}
            currentMemberId={currentMemberId}
            disabled={pending}
            onSelect={(status) => {
              const command = getTaskMoveCommand(task, currentMemberId, status);
              if (command) void run(command);
            }}
          />
        </TaskField>
        <TaskField label={m.tasks_overview_owner()}>
          <AssigneeMenu
            task={task}
            members={assignableMembers}
            disabled={pending || !currentMemberId || !canEditAssignment}
            onSelect={(assignee) =>
              void run(
                assignee
                  ? { operation: "assign", number: task.number, assignee }
                  : { operation: "unassign", number: task.number },
              )
            }
          />
        </TaskField>
        <TaskField label={m.tasks_created_by()} className="max-sm:hidden">
          <TaskPerson person={creator} />
        </TaskField>
        {source && (
          <TaskField label={m.tasks_source()} className="sm:col-span-3">
            <TaskSourceLink {...source} />
          </TaskField>
        )}
      </dl>
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error === "permission"
            ? m.tasks_assignment_requires_workspace_manager()
            : m.tasks_update_failed()}
        </p>
      )}

      <div className="border-t border-secondary pt-2 sm:pt-3">
        <Button
          color="link-gray"
          size="sm"
          iconTrailing={historyOpen ? ChevronUp : ChevronDown}
          aria-expanded={historyOpen}
          onPress={() => setHistoryOpen((value) => !value)}
        >
          {m.tasks_history()}
        </Button>
        {historyOpen && (
          <div className="max-h-40 overflow-y-auto pr-2 sm:max-h-64">
            <TaskHistory failed={history.isError} events={history.data} names={names} />
          </div>
        )}
      </div>
    </section>
  );
}

/** One field of the popup: its label above its value (or the control that edits it), or to its
 * left on a phone. */
function TaskField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 sm:flex-col sm:items-stretch sm:gap-1",
        className,
      )}
    >
      <dt className="shrink-0 text-xs text-tertiary sm:text-sm">{label}</dt>
      <dd className="flex min-h-8 min-w-0 items-center">{children}</dd>
    </div>
  );
}

function StatusMenu({
  task,
  currentMemberId,
  disabled,
  onSelect,
}: {
  task: TaskView;
  currentMemberId: string | null;
  disabled: boolean;
  onSelect: (status: TaskStatus) => void;
}) {
  const options = taskStatusOptions(task, currentMemberId);
  if (options.length === 1) return <StatusBadge status={task.status} />;
  return (
    <Dropdown.Root>
      <EditableTrigger
        label={`${m.tasks_change_status()}: ${statusLabel(task.status)}`}
        disabled={disabled}
      >
        <StatusBadge status={task.status} />
      </EditableTrigger>
      <Dropdown.Popover placement="bottom start" className="w-52">
        <Dropdown.Menu
          aria-label={m.tasks_change_status()}
          selectionMode="single"
          selectedKeys={[task.status]}
          onAction={(key) => {
            const status = options.find((option) => option === key);
            if (status && status !== task.status) onSelect(status);
          }}
        >
          {options.map((status) => (
            <Dropdown.Item
              key={status}
              id={status}
              label={
                task.status === "closed" && status === "todo"
                  ? m.tasks_reopen_to_todo()
                  : statusLabel(status)
              }
            />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
