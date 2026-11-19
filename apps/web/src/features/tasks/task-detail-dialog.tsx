import type { TaskView } from "@lrm/coforge-sdk/internal";
import { MemberDirectory } from "#src/features/conversations/member-directory";
import { DotsHorizontal as MoreHorizontal, XClose } from "@untitledui/icons";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { TaskTrail } from "./task-trail";
import { taskDeleteMenuItem, useCanDeleteTask, useDeleteTask } from "./task-delete";
import type { VisibleTaskName } from "./task-relation-edits";
import { taskRelationMenuItems } from "./task-relation-lines";
import { TaskHistoryPage, TaskSubtasks } from "./task-detail-sections";
import { TaskDescription } from "./task-description";
import { TaskSection, type RelationPicker } from "./task-section";
import { ownsDiscussion, taskFollowMenuItem, useTaskFollow } from "./task-follow";
import { isTaskStep } from "./task-popup-steps";
import { statusLabel, taskStatusColor, type TaskControls } from "./task-workflow";
import { useTaskDialogTransition } from "./use-task-dialog-transition";
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
  const deleteTask = useDeleteTask({ task, onCommand: dialog.onCommand });
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
              if (key === "delete") return void deleteTask();
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
                        className={`size-2 shrink-0 rounded-full ${taskStatusColor(status).dot}`}
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
  thread?: (lead: ReactNode) => ReactNode;
  /** Opens a Task this one is related to, in its own channel where that is where it lives. Where
   * absent, related Tasks are named but not opened. */
  onOpenRelated?: (task: VisibleTaskName) => void;
};

/** A phone top bar's button: 44px to touch, its icon centred. */
const PHONE_BAR_BUTTON = "max-sm:size-11 max-sm:justify-center";

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
  const deleteTask = useDeleteTask({
    task,
    onCommand,
    onDeleted: () => {
      onOpenChange(false);
      onDeleted?.();
    },
  });
  // The relation pickers belong to the popup, not its task section: the header menu opens them too.
  const [picker, setPicker] = useState<RelationPicker | null>(null);
  const [history, setHistory] = useState(false);
  const canDelete = useCanDeleteTask(task, currentMemberId);
  const relations = useTaskRelationAccess(task, currentMemberId);
  // A Task followed for its own conversation; a message's thread keeps the thread's own follow.
  const follow = useTaskFollow(task, open && Boolean(thread) && ownsDiscussion(task));
  const sidebar = useMediaQuery("(min-width: 1024px)", true);
  // Opened from another Task's popup: Esc and the back arrow step back up to it (browser Back
  // does by itself); only the first popup closes.
  const router = useRouter();
  const step = useRouterState({ select: (state) => isTaskStep(state.location) });
  const stepBack = step ? () => router.history.back() : undefined;
  // Esc on a step goes back up to the popup it was opened from; the overlay's own Escape, which
  // would close every step at once, is off while it is a step. Esc is the popup's only after
  // everything inside has had it: an input method composing, the composer's mention or task
  // completion, a menu, a picker, an image or a confirmation over the popup each take their own
  // Escape first (they mark it handled), and only an Escape nothing took steps back (task #478).
  const stepOnEscape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Taken inside (the composer's completion closing): the overlay, which does not look at
    // that, must not close the popup on the same press.
    if (event.defaultPrevented) return event.stopPropagation();
    if ((!step && !history) || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // Only from the popup itself, not from an overlay over it that the React tree passes through.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.preventDefault();
    if (history) setHistory(false);
    else router.history.back();
  };
  const {
    reduced,
    modalContentRef,
    titleRef,
    contentVisible,
    dragStyle,
    requestClose,
    handleOpenChange,
    headerDragProps,
  } = useTaskDialogTransition({
    taskId: task.id,
    taskNumber: task.number,
    open,
    onOpenChange,
  });

  useHotkey(
    "Escape",
    (event) => {
      if (event.target !== document.body && event.target !== document.documentElement) return;
      event.preventDefault();
      if (history) setHistory(false);
      else if (stepBack) stepBack();
      else requestClose();
    },
    { enabled: open, preventDefault: false },
  );
  const section = (
    <TaskSection
      layout={sidebar ? "sidebar" : "chips"}
      task={task}
      onCommand={onCommand}
      members={members}
      currentMemberId={currentMemberId}
      picker={picker}
      onPickerChange={setPicker}
      onOpenRelated={onOpenRelated}
    />
  );
  const description = task.description?.trim();
  const lead = (
    <div className="flex flex-col gap-5 px-4 pt-4 pb-6 sm:px-8 sm:pt-6">
      <div className="flex flex-col gap-3">
        <Heading
          ref={titleRef}
          slot="title"
          level={2}
          className="text-xl font-semibold break-words text-primary"
        >
          {task.title}
        </Heading>
        {!sidebar && <div className="-mx-4 sm:-mx-8 sm:[&_dl]:px-8">{section}</div>}
      </div>
      {description && <TaskDescription text={description} />}
      {task.subtasks && (
        <TaskSubtasks
          task={task}
          canAdd={relations.canEdit}
          onAdd={() => setPicker("subtask")}
          onOpen={onOpenRelated}
        />
      )}
    </div>
  );
  const discussion = thread?.(lead);
  return (
    <>
      <TaskPopupOverlay
        isOpen={open}
        onOpenChange={handleOpenChange}
        keyboardDismiss={!step && !history}
      >
        <Modal
          style={dragStyle}
          className={cn(
            "flex h-full w-full flex-col overflow-hidden rounded-none max-sm:overflow-hidden max-sm:shadow-none max-sm:safe-area-padding",
            !reduced && "animate-none!",
            thread ? "sm:h-[min(92vh,52rem)]" : "sm:h-auto sm:max-h-[min(92vh,64rem)]",
            sidebar ? "sm:w-[min(68rem,calc(100vw-2rem))]" : "sm:w-[min(48rem,calc(100vw-2rem))]",
          )}
        >
          <div ref={modalContentRef} className="contents" onKeyDown={stepOnEscape}>
            <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div
                {...headerDragProps}
                className="flex shrink-0 items-center gap-1 pt-2 pr-3 pl-2 max-sm:h-11 max-sm:touch-none max-sm:gap-0 max-sm:p-0 sm:pl-4"
              >
                <TaskTrail
                  task={task}
                  conversationName={conversationName}
                  onBack={stepBack}
                  onOpenRelated={onOpenRelated}
                />
                <Dropdown.Root>
                  <ButtonUtility
                    tooltip={m.tasks_more_actions({ number: String(task.number) })}
                    icon={MoreHorizontal}
                    size="sm"
                    color="tertiary"
                    className={PHONE_BAR_BUTTON}
                  />
                  <Dropdown.Popover placement="bottom end">
                    <Dropdown.Menu
                      onAction={(key) => {
                        if (key === "delete") void deleteTask();
                        else if (key === "history") setHistory(true);
                        else if (key === "parent" || key === "blocker" || key === "subtask")
                          setPicker(key);
                      }}
                    >
                      <Dropdown.Section>
                        {taskRelationMenuItems({
                          canEdit: relations.canEdit,
                          canAddBlocker: relations.canAddBlocker,
                          hasParent: task.parent != null,
                        })}
                      </Dropdown.Section>
                      <Dropdown.Section className="border-t border-secondary pt-1">
                        <Dropdown.Item id="history" label={m.tasks_full_history()} />
                      </Dropdown.Section>
                      {(follow || canDelete) && (
                        <Dropdown.Section className="border-t border-secondary pt-1">
                          {follow && taskFollowMenuItem(follow)}
                          {canDelete && taskDeleteMenuItem()}
                        </Dropdown.Section>
                      )}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.Root>
                <ButtonUtility
                  icon={XClose}
                  size="sm"
                  color="tertiary"
                  aria-label={m.tasks_close()}
                  onClick={requestClose}
                  className={cn(PHONE_BAR_BUTTON, "max-sm:order-first")}
                />
              </div>
              <div
                className={cn(
                  "flex min-h-0 flex-1 border-t border-secondary transition-opacity duration-200",
                  contentVisible ? "opacity-100" : "opacity-0",
                )}
              >
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {history ? (
                    <TaskHistoryPage
                      task={task}
                      members={members}
                      onBack={() => setHistory(false)}
                    />
                  ) : discussion ? (
                    <MemberDirectory members={members}>{discussion}</MemberDirectory>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto">{lead}</div>
                  )}
                </div>
                {sidebar && (
                  <aside className="w-72 shrink-0 overflow-y-auto border-l border-secondary bg-secondary_alt px-5 py-5">
                    {section}
                  </aside>
                )}
              </div>
            </Dialog>
          </div>
        </Modal>
      </TaskPopupOverlay>
    </>
  );
}

/**
 * The popup's overlay. A phone shows the popup as a full-screen sheet over the visual viewport the
 * overlay follows: with the keyboard up, the header stays at the top and the composer sits right
 * above the keyboard.
 */
function TaskPopupOverlay({
  keyboardDismiss,
  ...props
}: Pick<ComponentProps<typeof ModalOverlay>, "isOpen" | "onOpenChange" | "children"> & {
  /** Off for a step, whose Escape steps back instead of closing every step. */
  keyboardDismiss: boolean;
}) {
  return (
    <ModalOverlay
      {...props}
      isKeyboardDismissDisabled={!keyboardDismiss}
      isDismissable
      className="max-sm:items-stretch max-sm:px-0 max-sm:[--modal-pb:0px] max-sm:[--modal-pt:0px]"
    />
  );
}
