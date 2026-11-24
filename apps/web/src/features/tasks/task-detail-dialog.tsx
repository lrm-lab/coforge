import type { TaskView } from "@lrm/coforge-sdk/internal";
import { MemberDirectory } from "#src/features/conversations/member-directory";
import { ArrowUp, DotsHorizontal as MoreHorizontal, XClose } from "@untitledui/icons";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Button } from "#src/components/base/buttons/button";
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
import { useTaskLeadScroll } from "./task-lead-scroll";
import { isTaskStep } from "./task-popup-steps";
import { statusLabel, taskStatusColor, type TaskControls } from "./task-workflow";
import { useTaskDialogTransition } from "./use-task-dialog-transition";
import { useTaskRelationAccess, type DetailCommand } from "./use-task-relations";

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
  start?: "focus" | "open";
  onStarted?: () => void;
  moves?: TaskControls["moves"];
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
              <Dropdown.Item id="details" label={m.task_menu_view_details()} />
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
  onCommand?: (command: DetailCommand) => Promise<void>;
  onDeleted?: () => void;
  conversationName?: string;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  thread?: (lead: ReactNode) => ReactNode;
  onOpenRelated?: (task: VisibleTaskName) => void;
};

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
  const [picker, setPicker] = useState<RelationPicker | null>(null);
  const [history, setHistory] = useState(false);
  const canDelete = useCanDeleteTask(task, currentMemberId);
  const relations = useTaskRelationAccess(task, currentMemberId);
  const follow = useTaskFollow(task, open && Boolean(thread) && ownsDiscussion(task));
  const sidebar = useMediaQuery("(min-width: 64rem)", true);
  const router = useRouter();
  const step = useRouterState({ select: (state) => isTaskStep(state.location) });
  const stepBack = step ? () => router.history.back() : undefined;
  const stepOnEscape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    if (event.defaultPrevented) return event.stopPropagation();
    if ((!step && !history) || event.nativeEvent.isComposing || event.keyCode === 229) return;
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

  const { setTitleElement, scrolledOut, canScrollToTop, scrollToTop } = useTaskLeadScroll({
    boundaryRef: modalContentRef,
    reducedMotion: reduced,
  });
  const showBackToTop = canScrollToTop && !history;
  const setTitleNode = useCallback(
    (node: HTMLHeadingElement | null) => {
      titleRef.current = node;
      setTitleElement(node);
    },
    [titleRef, setTitleElement],
  );

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
          ref={setTitleNode}
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
                className="flex shrink-0 items-center gap-1 pt-2 pe-3 ps-2 max-sm:h-11 max-sm:touch-none max-sm:gap-0 max-sm:p-0 sm:ps-4"
              >
                <TaskTrail
                  task={task}
                  conversationName={conversationName}
                  onBack={stepBack}
                  onOpenRelated={onOpenRelated}
                  onScrollToTop={scrolledOut && !history ? scrollToTop : undefined}
                />
                {showBackToTop && (
                  <Button
                    aria-label={m.tasks_scroll_to_top()}
                    color="tertiary"
                    size="sm"
                    iconLeading={ArrowUp}
                    onPress={scrollToTop}
                    className="shrink-0 gap-1 px-1.5 text-xs font-medium whitespace-nowrap max-sm:h-11 max-sm:w-24 max-xs:w-18 max-xs:flex-col max-xs:gap-0 *:data-icon:size-4"
                  >
                    {m.tasks_scroll_to_top()}
                  </Button>
                )}
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
                  className={cn(
                    PHONE_BAR_BUTTON,
                    "max-sm:order-first",
                    showBackToTop && "max-sm:me-24 max-xs:me-18",
                  )}
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
                  <aside className="w-72 shrink-0 overflow-x-hidden overflow-y-auto border-s border-secondary bg-secondary_alt px-5 py-5">
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

function TaskPopupOverlay({
  keyboardDismiss,
  ...props
}: Pick<ComponentProps<typeof ModalOverlay>, "isOpen" | "onOpenChange" | "children"> & {
  keyboardDismiss: boolean;
}) {
  return (
    <ModalOverlay
      {...props}
      isKeyboardDismissDisabled={!keyboardDismiss}
      isDismissable
      className="max-sm:items-stretch max-sm:px-0 max-sm:[--modal-pb:0rem] max-sm:[--modal-pt:0rem] max-sm:[@media(display-mode:standalone)]:visible"
    />
  );
}
