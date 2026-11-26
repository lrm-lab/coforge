import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useHotkey } from "@tanstack/react-hotkeys";
import { DotsHorizontal as MoreHorizontal } from "@untitledui/icons";
import { AnimatePresence, useMotionValue } from "motion/react";
import * as motion from "motion/react-m";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { ComposerHostContext, type ComposerHost } from "#src/features/conversations/composer-host";
import {
  ComposerScopeProvider,
  type ComposerScope,
} from "#src/features/conversations/composer-scope";
import { ConversationSplit } from "#src/features/conversations/conversation-split";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { useEdgeSwipeBack } from "#src/hooks/use-edge-swipe-back";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { DURATION_S, EASE_IN, EASE_OUT } from "#src/utils/motion-tokens";
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
  sidePanel?: ReactNode;
  onCloseSidePanel?: () => void;
};

const NOOP = () => {};

function useDialogSidePanelEscape(
  open: boolean,
  container: HTMLElement | null,
  onClose: (() => void) | undefined,
) {
  useHotkey(
    "Escape",
    (event) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const overlays = document.querySelectorAll(OPEN_OVERLAY_SELECTOR);
      if (overlays.length > 0 && container && overlays.item(overlays.length - 1) !== container)
        return;
      event.preventDefault();
      onClose?.();
    },
    {
      target: container,
      enabled: open && Boolean(container) && Boolean(onClose),
      ignoreInputs: true,
      preventDefault: false,
    },
  );
}

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
  sidePanel,
  onCloseSidePanel,
}: TaskDetailDialogProps) {
  const [expanded, setExpanded] = useState(false);
  const [dialogEl, setDialogEl] = useState<HTMLElement | null>(null);
  const close = useCallback(() => {
    setExpanded(false);
    onOpenChange(false);
  }, [onOpenChange]);
  const hasSidePanel = Boolean(sidePanel);
  useDialogSidePanelEscape(open && hasSidePanel, dialogEl, onCloseSidePanel);
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
    escapeEnabled: !hasSidePanel,
    overlay: true,
    titleSlot: "title",
  });
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      isDismissable
      isKeyboardDismissDisabled={!model.keyboardDismiss || hasSidePanel}
      className="items-stretch justify-end p-0 [--modal-pb:0rem] [--modal-pt:0rem] sm:items-stretch sm:justify-end sm:p-0 sm:[--modal-pb:0rem] sm:[--modal-pt:0rem]"
    >
      <Modal
        className={cn(
          "flex h-full max-h-none flex-col overflow-hidden rounded-none border-s border-secondary bg-primary shadow-xl transition-[width] duration-200 ease-out motion-reduce:transition-none sm:rounded-none",
          expanded || hasSidePanel ? "w-[min(68rem,calc(100vw-2rem))]" : "w-[min(38rem,100vw)]",
        )}
      >
        <div ref={model.rootRef} onKeyDown={model.onKeyDown} className="contents">
          <Dialog ref={setDialogEl} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ConversationSplit
              layoutId="coforge-task-profile"
              reportListCrowd={false}
              forceSplit
              main={
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {model.header}
                  {model.body}
                </div>
              }
              side={sidePanel}
              visibleSlot={hasSidePanel ? "profile" : undefined}
              threadAlone={false}
            />
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

function MobileTaskSideOverlay({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
}) {
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const swipeX = useMotionValue("0%");
  const handleProgress = useCallback(
    (progress: number) => {
      swipeX.jump(`${progress * 100}%`);
    },
    [swipeX],
  );
  const swipe = useEdgeSwipeBack({
    enabled: open && !reduced && Boolean(onClose),
    onBack: onClose ?? NOOP,
    onProgress: handleProgress,
  });
  useDialogSidePanelEscape(open, overlayEl, onClose);
  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    return () => {
      const activeSheets = document.querySelectorAll<HTMLElement>(
        "[data-detent-sheet]:not([inert]) [role='dialog']",
      );
      const target =
        previousFocusRef.current &&
        previousFocusRef.current.isConnected &&
        !previousFocusRef.current.closest("[inert]")
          ? previousFocusRef.current
          : activeSheets.item(activeSheets.length - 1);
      target?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (overlayEl && !overlayEl.contains(document.activeElement))
      overlayEl.focus({ preventScroll: true });
  }, [overlayEl]);
  return (
    <motion.div
      ref={setOverlayEl}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={m.agent_profile_tab()}
      {...swipe.bind}
      style={reduced ? undefined : { x: swipeX }}
      initial={reduced ? { opacity: 0 } : { x: "100%" }}
      animate={reduced ? { opacity: 1 } : swipe.dragging ? undefined : { x: "0%" }}
      exit={
        reduced
          ? { opacity: 0, transition: { duration: DURATION_S.reduced } }
          : { x: "100%", transition: { duration: DURATION_S.lgOut, ease: EASE_IN } }
      }
      transition={
        swipe.dragging
          ? { duration: 0 }
          : reduced
            ? { duration: DURATION_S.reduced }
            : swipe.settling
              ? { type: "spring", stiffness: 380, damping: 32 }
              : { duration: DURATION_S.lg, ease: EASE_OUT }
      }
      className="visible pointer-events-auto fixed inset-x-0 top-(--visual-viewport-top,0px) z-20 flex h-(--visual-viewport-height,var(--app-height,100dvh)) min-h-0 min-w-0 [touch-action:pan-y_pinch-zoom] flex-col bg-primary pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left shadow-2xl outline-hidden [&_.overflow-y-auto]:[touch-action:pan-y_pinch-zoom]"
    >
      {children}
    </motion.div>
  );
}

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
  sidePanel,
  onCloseSidePanel,
}: TaskDetailDialogProps) {
  const [detent, setDetent] = useState<TaskDetent>("half");
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDetent("half");
  }
  const [composerPortal, setComposerPortal] = useState<HTMLDivElement | null>(null);
  const dismissRef = useRef<(() => void) | null>(null);
  const hasSidePanel = Boolean(sidePanel);
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
    escapeEnabled: !hasSidePanel,
    overlay: true,
    titleSlot: "title",
  });
  const sideOverlay = (
    <AnimatePresence initial={false}>
      {sidePanel && (
        <MobileTaskSideOverlay key="task-mobile-side-panel" open={open} onClose={onCloseSidePanel}>
          {sidePanel}
        </MobileTaskSideOverlay>
      )}
    </AnimatePresence>
  );
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
      keyboardDismiss={model.keyboardDismiss && !hasSidePanel}
      inertSheet={hasSidePanel}
      overlay={sideOverlay}
      onKeyDown={model.onKeyDown}
    >
      <ComposerHostContext value={MOBILE_SHEET_COMPOSER_HOST}>
        <ComposerScopeProvider value={composerScope}>
          <div ref={model.rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {model.body}
          </div>
        </ComposerScopeProvider>
      </ComposerHostContext>
    </TaskDetentSheet>
  );
}
