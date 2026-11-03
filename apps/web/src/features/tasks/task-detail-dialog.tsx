import type { TaskView } from "@lrm/coforge-sdk/internal";
import {
  ArrowLeft,
  ChevronRight,
  DotsHorizontal as MoreHorizontal,
  XClose,
} from "@untitledui/icons";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button as AriaButton, Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { TaskStatusIcon } from "./task-status-icon";
import { TaskDeleteDialog, taskDeleteMenuItem, useCanDeleteTask } from "./task-delete";
import type { VisibleTaskName } from "./task-relation-edits";
import { taskRelationMenuItems } from "./task-relation-lines";
import {
  TaskDetailTabs,
  TaskHistoryPage,
  TaskSubtasksPage,
  type TaskDetailTab,
} from "./task-detail-tabs";
import { TaskSection, type RelationPicker } from "./task-section";
import { ownsDiscussion, taskFollowMenuItem, useTaskFollow } from "./task-follow";
import { isTaskStep } from "./task-popup-steps";
import { statusLabel, TASK_STATUS_COLOR, type TaskControls } from "./task-workflow";
import { useTaskRelationAccess, type DetailCommand } from "./use-task-relations";

/** A Task card's "More actions" button, as the menu shows it and as the card's stand-in for the
 * menu does until someone reaches for it (`BoardTaskCard`). */
export function taskMenuButton(task: Pick<TaskView, "number">) {
  return {
    label: m.tasks_more_actions({ number: String(task.number) }),
    icon: MoreHorizontal,
    size: "xs",
    color: "tertiary",
  } as const;
}

export function TaskDetailMenu({
  task,
  moves = [],
  onOpenDetails,
  start,
  onStarted,
  ...dialog
}: Omit<TaskDetailDialogProps, "open" | "onOpenChange" | "thread"> & {
  /** What the stand-in this replaces was doing: tabbed to (`focus`) or pressed (`open`). The
   * button takes the focus first, so the menu gives it back there when it closes; then, if the
   * stand-in was pressed, the menu opens. `onStarted` says it is done, so a later mount (another
   * layout) does neither. */
  start?: "focus" | "open";
  onStarted?: () => void;
  /** Board and list moves, listed under "Move to". */
  moves?: TaskControls["moves"];
  /** Opens the caller's own Task popup for "View details" — the conversation's, which also
   * shows the Task's thread. Without it the menu opens a popup of the Task alone. */
  onOpenDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const canDelete = useCanDeleteTask(task, dialog.currentMemberId);
  useEffect(() => {
    if (!start) return;
    trigger.current?.focus();
    if (start === "open") setMenuOpen(true);
    onStarted?.();
  }, [start, onStarted]);
  const { label, ...button } = taskMenuButton(task);
  return (
    <>
      <Dropdown.Root isOpen={menuOpen} onOpenChange={setMenuOpen}>
        <ButtonUtility ref={trigger} tooltip={label} {...button} />
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
  thread?: () => ReactNode;
  /** Opens a Task this one is related to, in its own channel where that is where it lives. Where
   * absent, related Tasks are named but not opened. */
  onOpenRelated?: (task: VisibleTaskName) => void;
};

/**
 * The Task popup: its title and properties, then tabs for the discussion (where the caller owns
 * the conversation, the Task message's thread, which `thread` renders around the section), the
 * sub-tasks and History.
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
  onOpenRelated,
}: TaskDetailDialogProps) {
  const [deleting, setDeleting] = useState(false);
  // The relation pickers belong to the popup, not its task section: the header menu opens them too.
  const [picker, setPicker] = useState<RelationPicker | null>(null);
  const [tab, setTab] = useState<TaskDetailTab>("discussion");
  const canDelete = useCanDeleteTask(task, currentMemberId);
  const relations = useTaskRelationAccess(task, currentMemberId);
  // A Task followed for its own conversation; a message's thread keeps the thread's own follow.
  const follow = useTaskFollow(task, open && Boolean(thread) && ownsDiscussion(task));
  // The properties are a column beside the tabs, as Linear's issue; a phone has no room beside.
  const sidebar = !useMediaQuery("(max-width: 639px)", false);
  // Opened from another Task's popup: Esc and the back arrow step back up to it (browser Back
  // does by itself); only the first popup closes.
  const router = useRouter();
  const step = useRouterState({ select: (state) => isTaskStep(state.location) });
  const stepBack = step ? () => router.history.back() : undefined;
  const section = (
    <TaskSection
      layout={sidebar ? "sidebar" : "column"}
      task={task}
      onCommand={onCommand}
      members={members}
      currentMemberId={currentMemberId}
      picker={picker}
      onPickerChange={setPicker}
      onOpenRelated={onOpenRelated}
    />
  );
  // The discussion is there only with a thread; the sub-tasks only once there are some.
  const tabs: TaskDetailTab[] = [
    ...(thread ? (["discussion"] as const) : []),
    ...(relations.on && task.subtasks ? (["subtasks"] as const) : []),
    "history",
  ];
  const current = tabs.includes(tab) ? tab : tabs[0];
  return (
    <>
      <TaskPopupOverlay isOpen={open} onOpenChange={onOpenChange}>
        <Modal
          className={cn(
            // On a phone the thread scrolls, never the sheet (the shared Modal scrolls there).
            "flex h-full w-full flex-col overflow-hidden rounded-none max-sm:overflow-hidden max-sm:shadow-none max-sm:safe-area-padding",
            // The popup hugs what it shows, up to a cap; the discussion keeps a reading height of
            // its own. With a thread or the side column it is a workspace; else it wraps the task.
            "sm:h-auto sm:max-h-[min(92vh,64rem)]",
            thread || sidebar
              ? "sm:w-[min(60rem,calc(100vw-2rem))]"
              : "sm:w-[min(44rem,calc(100vw-2rem))]",
          )}
        >
          <div
            className="contents"
            onKeyDownCapture={(event) => {
              // Before the overlay's own Escape, which would close every step at once. It wraps the
              // dialog itself, which holds focus right after a step opens (task #472). A menu or
              // picker, in a popover outside the dialog, handles its own Escape.
              if (event.key !== "Escape" || !stepBack || event.defaultPrevented) return;
              if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target))
                return;
              event.preventDefault();
              event.stopPropagation();
              stepBack();
            }}
          >
            <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 items-center gap-1 pt-2 pr-3 pl-2 sm:pl-4">
                <TaskTrail
                  task={task}
                  conversationName={conversationName}
                  onBack={stepBack}
                  onOpenRelated={onOpenRelated}
                />
                {(relations.on || follow || canDelete) && (
                  <Dropdown.Root>
                    <ButtonUtility
                      tooltip={m.tasks_more_actions({ number: String(task.number) })}
                      icon={MoreHorizontal}
                      size="sm"
                      color="tertiary"
                    />
                    <Dropdown.Popover placement="bottom end">
                      <Dropdown.Menu
                        onAction={(key) => {
                          if (key === "delete") setDeleting(true);
                          else if (key === "parent" || key === "blocker" || key === "subtask")
                            setPicker(key);
                        }}
                      >
                        {relations.on && (
                          <Dropdown.Section>
                            {taskRelationMenuItems({
                              canEdit: relations.canEdit,
                              canAddBlocker: relations.canAddBlocker,
                              hasParent: task.parent != null,
                            })}
                          </Dropdown.Section>
                        )}
                        {(follow || canDelete) && (
                          <Dropdown.Section
                            className={cn(relations.on && "border-t border-secondary pt-1")}
                          >
                            {follow && taskFollowMenuItem(follow)}
                            {canDelete && taskDeleteMenuItem()}
                          </Dropdown.Section>
                        )}
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
              <TaskDetailTabs
                tabs={tabs}
                selected={current}
                onChange={setTab}
                subtasks={task.subtasks}
                task={
                  <>
                    <Heading
                      slot="title"
                      level={2}
                      className="flex items-start gap-2 px-4 pt-2 text-lg font-semibold break-words text-primary sm:px-6"
                    >
                      <TaskStatusIcon status={task.status} className="mt-1 size-5" />
                      <span className="line-clamp-3 min-w-0">{task.title}</span>
                    </Heading>
                    {task.description?.trim() && (
                      // The description under the title, as Linear's issue; long ones are cut.
                      <p className="line-clamp-6 px-4 text-sm whitespace-pre-wrap text-secondary sm:px-6">
                        {task.description.trim()}
                      </p>
                    )}
                    {!sidebar && section}
                  </>
                }
                sidebar={sidebar ? section : undefined}
                pages={{
                  discussion: () => thread?.(),
                  subtasks: () => (
                    <TaskSubtasksPage
                      task={task}
                      canAdd={relations.canEdit}
                      onAdd={() => setPicker("subtask")}
                      onOpen={onOpenRelated}
                    />
                  ),
                  history: () => <TaskHistoryPage task={task} members={members} />,
                }}
              />
            </Dialog>
          </div>
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

/**
 * Where the Task sits, above its title: a back arrow to the popup it was opened from, if any; the
 * Task it is a step of, to go up to; then its conversation and number. A parent the reader cannot
 * see is named as such and opens nothing.
 */
function TaskTrail({
  task,
  conversationName,
  onBack,
  onOpenRelated,
}: {
  task: TaskView;
  conversationName?: string;
  onBack?: () => void;
  onOpenRelated?: (task: VisibleTaskName) => void;
}) {
  const parent = task.parent;
  const openParent =
    parent && !parent.hidden && onOpenRelated ? () => onOpenRelated(parent) : undefined;
  const here = conversationName
    ? `#${conversationName.replace(/^#/, "")} · #${task.number}`
    : `#${task.number}`;
  return (
    <nav
      aria-label={m.tasks_trail()}
      className="flex min-w-0 flex-1 items-center gap-1 text-sm text-tertiary"
    >
      {onBack ? (
        <ButtonUtility
          icon={ArrowLeft}
          size="sm"
          color="tertiary"
          tooltip={m.tasks_back()}
          onClick={onBack}
        />
      ) : (
        <span aria-hidden="true" className="w-1" />
      )}
      {parent && (
        <>
          {openParent && !parent.hidden ? (
            <AriaButton
              onPress={openParent}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 outline-none hover:bg-primary_hover hover:text-secondary focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <TaskStatusIcon status={parent.status} className="size-3.5" />
              <span className="max-w-[24em] truncate">{parent.title}</span>
            </AriaButton>
          ) : (
            <span className="truncate px-1">{m.tasks_ref_hidden()}</span>
          )}
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
        </>
      )}
      <span className="shrink-0 px-1 tabular-nums">{here}</span>
    </nav>
  );
}
