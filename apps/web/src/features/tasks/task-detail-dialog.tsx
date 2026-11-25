import type { TaskView } from "@lrm/coforge-sdk/internal";
import { DotsHorizontal as MoreHorizontal } from "@untitledui/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { ComposerHostContext, type ComposerHost } from "#src/features/conversations/composer-host";
import {
  ComposerScopeProvider,
  type ComposerScope,
} from "#src/features/conversations/composer-scope";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { taskDeleteMenuItem, useCanDeleteTask, useDeleteTask } from "./task-delete";
import { useTaskDetailModel } from "./task-detail-panel";
import { TaskDetentSheet, type TaskDetent } from "./task-detent-sheet";
import type { VisibleTaskName } from "./task-relation-edits";
import { statusLabel, taskStatusColor, type TaskControls } from "./task-workflow";
import type { DetailCommand } from "./use-task-relations";

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

export type TaskDetailDialogProps = {
  task: TaskView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommand?: (command: DetailCommand) => Promise<void>;
  onDeleted?: () => void;
  conversationName?: string;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  thread?: (lead: ReactNode) => ReactNode;
  leadExtra?: ReactNode;
  onOpenRelated?: (task: VisibleTaskName) => void;
};

export function TaskDetailDialog(props: TaskDetailDialogProps) {
  const desktop = useMediaQuery("(min-width: 64rem)", true);
  return desktop ? <DesktopTaskDrawer {...props} /> : <MobileTaskSheet {...props} />;
}

function DesktopTaskDrawer({
  task,
  open,
  onOpenChange,
  onCommand,
  onDeleted,
  conversationName,
  members,
  currentMemberId,
  thread,
  leadExtra,
  onOpenRelated,
}: TaskDetailDialogProps) {
  const [expanded, setExpanded] = useState(false);
  const close = useCallback(() => {
    setExpanded(false);
    onOpenChange(false);
  }, [onOpenChange]);
  const model = useTaskDetailModel({
    task,
    mode: expanded ? "expanded" : "drawer",
    onClose: close,
    onCommand,
    onDeleted,
    conversationName,
    members,
    currentMemberId,
    thread,
    leadExtra,
    onOpenRelated,
    expanded,
    onToggleExpand: () => setExpanded((current) => !current),
    active: open,
    closeOnEscape: false,
    titleSlot: "title",
  });
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      isDismissable
      isKeyboardDismissDisabled={!model.keyboardDismiss}
      className="items-stretch justify-end p-0 [--modal-pb:0rem] [--modal-pt:0rem] sm:items-stretch sm:justify-end sm:p-0 sm:[--modal-pb:0rem] sm:[--modal-pt:0rem]"
    >
      <Modal
        className={cn(
          "flex h-full max-h-none flex-col overflow-hidden rounded-none border-s border-secondary bg-primary shadow-xl transition-[width] duration-200 ease-out motion-reduce:transition-none sm:rounded-none",
          expanded ? "w-[min(68rem,calc(100vw-2rem))]" : "w-[min(38rem,100vw)]",
        )}
      >
        <div ref={model.rootRef} onKeyDown={model.onKeyDown} className="contents">
          <Dialog className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {model.header}
            {model.body}
          </Dialog>
        </div>
      </Modal>
    </ModalOverlay>
  );
}

const MOBILE_SHEET_COMPOSER_HOST: ComposerHost = {
  autoFocus: false,
  showAgentActivity: false,
  forTask: true,
};

function MobileTaskSheet({
  task,
  open,
  onOpenChange,
  onCommand,
  onDeleted,
  conversationName,
  members,
  currentMemberId,
  thread,
  leadExtra,
  onOpenRelated,
}: TaskDetailDialogProps) {
  const [detent, setDetent] = useState<TaskDetent>("half");
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDetent("half");
  }
  const [composerPortal, setComposerPortal] = useState<HTMLDivElement | null>(null);
  const dismissRef = useRef<(() => void) | null>(null);
  const close = useCallback(() => {
    if (dismissRef.current) dismissRef.current();
    else onOpenChange(false);
  }, [onOpenChange]);
  const promoteFull = useCallback(() => setDetent("full"), []);
  const toggleDetent = useCallback(
    () => setDetent((current) => (current === "full" ? "half" : "full")),
    [],
  );
  const composerScope = useMemo<ComposerScope>(() => ({ composerPortal }), [composerPortal]);
  const model = useTaskDetailModel({
    task,
    mode: "sheet",
    onClose: close,
    onCommand,
    onDeleted,
    conversationName,
    members,
    currentMemberId,
    thread,
    leadExtra,
    onOpenRelated,
    detent,
    onToggleDetent: toggleDetent,
    onBeforeOpenPicker: promoteFull,
    active: open,
    closeOnEscape: false,
    titleSlot: "title",
  });
  return (
    <TaskDetentSheet
      open={open}
      onOpenChange={onOpenChange}
      detent={detent}
      defaultDetent="half"
      onDetentChange={setDetent}
      dismissRef={dismissRef}
      ariaLabel={m.tasks_details_title({ number: String(task.number) })}
      header={model.header}
      composer={thread && !model.hasHistory ? <div ref={setComposerPortal} /> : undefined}
      autoExpandOnComposerFocus
      keyboardDismiss={model.keyboardDismiss}
    >
      <ComposerHostContext value={MOBILE_SHEET_COMPOSER_HOST}>
        <ComposerScopeProvider value={composerScope}>
          <div
            ref={model.rootRef}
            onKeyDown={model.onKeyDown}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {model.body}
          </div>
        </ComposerScopeProvider>
      </ComposerHostContext>
    </TaskDetentSheet>
  );
}
