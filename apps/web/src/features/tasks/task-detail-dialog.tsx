import type { TaskView } from "@lrm/coforge-sdk/internal";
import { MemberDirectory } from "#src/features/conversations/member-directory";
import { DotsHorizontal as MoreHorizontal, XClose } from "@untitledui/icons";
import { useRouter, useRouterState } from "@tanstack/react-router";
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
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { TaskStatusIcon } from "./task-status-icon";
import { TaskTrail } from "./task-trail";
import { TaskDeleteDialog, taskDeleteMenuItem, useCanDeleteTask } from "./task-delete";
import type { VisibleTaskName } from "./task-relation-edits";
import { taskRelationMenuItems } from "./task-relation-lines";
import {
  TaskDetailTabs,
  TaskHistoryPage,
  TaskSubtasksPage,
  type TaskDetailTab,
} from "./task-detail-tabs";
import { TaskDescription } from "./task-description";
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
  // Esc on a step goes back up to the popup it was opened from; the overlay's own Escape, which
  // would close every step at once, is off while it is a step. Esc is the popup's only after
  // everything inside has had it: an input method composing, the composer's mention or task
  // completion, a menu, a picker, an image or a confirmation over the popup each take their own
  // Escape first (they mark it handled), and only an Escape nothing took steps back (task #478).
  const close = useLatestCallback(() => onOpenChange(false));
  const stepOnEscape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Taken inside (the composer's completion closing): the overlay, which does not look at
    // that, must not close the popup on the same press.
    if (event.defaultPrevented) return event.stopPropagation();
    if (!step || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // Only from the popup itself, not from an overlay over it that the React tree passes through.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.preventDefault();
    router.history.back();
  };
  // With focus left on the page (the row that opened a step is gone), the popup still hears Esc:
  // a step goes back, the first popup closes, as each does with focus inside.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      event.preventDefault();
      if (step) router.history.back();
      else close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, step, router, close]);
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
  // The discussion is there only with a thread; the sub-tasks only once there are some.
  const tabs: TaskDetailTab[] = [
    ...(thread ? (["discussion"] as const) : []),
    ...(relations.on && task.subtasks ? (["subtasks"] as const) : []),
    "history",
  ];
  const current = tabs.includes(tab) ? tab : tabs[0];
  return (
    <>
      <TaskPopupOverlay isOpen={open} onOpenChange={onOpenChange} keyboardDismiss={!step}>
        <Modal
          className={cn(
            // On a phone the thread scrolls, never the sheet (the shared Modal scrolls there).
            "flex h-full w-full flex-col overflow-hidden rounded-none max-sm:overflow-hidden max-sm:shadow-none max-sm:safe-area-padding",
            // With a discussion the popup is a workspace of one height, whatever the Task's text,
            // so a long description never squeezes the discussion (Frank, 11-04). Without one it
            // hugs the Task, up to the same cap.
            thread ? "sm:h-[min(92vh,48rem)]" : "sm:h-auto sm:max-h-[min(92vh,64rem)]",
            thread || sidebar
              ? "sm:w-[min(60rem,calc(100vw-2rem))]"
              : "sm:w-[min(44rem,calc(100vw-2rem))]",
          )}
        >
          <div className="contents" onKeyDown={stepOnEscape}>
            <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {/* On a phone the bar is the page's top bar (task #70): close on the left, where a
                  page's way out is, the Task's place centred, More on the right, each 44px to
                  touch, as task #54's New task page. */}
              <div className="flex shrink-0 items-center gap-1 pt-2 pr-3 pl-2 max-sm:h-11 max-sm:gap-0 max-sm:p-0 sm:pl-4">
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
                      className={PHONE_BAR_BUTTON}
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
                  className={cn(PHONE_BAR_BUTTON, "max-sm:order-first")}
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
                      {/* On a phone the status is the first block right under the title, so the
                          title does not say it again; three lines, as beside the pages. */}
                      <TaskStatusIcon status={task.status} className="mt-1 size-5 max-sm:hidden" />
                      <span className="line-clamp-3 min-w-0">{task.title}</span>
                    </Heading>
                    {/* On a phone the properties are one row of chips under the title, each its
                        own control, so the discussion keeps the screen (Frank, 11-04). */}
                    {!sidebar && section}
                    {task.description?.trim() && (
                      <TaskDescription text={task.description.trim()} short={!sidebar} />
                    )}
                  </>
                }
                sidebar={sidebar ? section : undefined}
                pages={{
                  // The popup is not inside the channel stream's directory: its notices and
                  // seen-by lists name people by the board's members (task #coforge-ui:#20).
                  discussion: () => (
                    <MemberDirectory members={members}>{thread?.()}</MemberDirectory>
                  ),
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
