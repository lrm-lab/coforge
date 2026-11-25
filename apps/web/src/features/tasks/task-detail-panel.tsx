import type { TaskView } from "@lrm/coforge-sdk/internal";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  DotsHorizontal as MoreHorizontal,
  Maximize02,
  Minimize02,
  XClose,
} from "@untitledui/icons";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Heading } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { MemberDirectory } from "#src/features/conversations/member-directory";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { taskDeleteMenuItem, useCanDeleteTask, useDeleteTask } from "./task-delete";
import { TaskDescription } from "./task-description";
import { TaskHistoryPage, TaskSubtasks } from "./task-detail-sections";
import { ownsDiscussion, taskFollowMenuItem, useTaskFollow } from "./task-follow";
import { useTaskLeadScroll } from "./task-lead-scroll";
import { isTaskStep } from "./task-popup-steps";
import type { VisibleTaskName } from "./task-relation-edits";
import { taskRelationMenuItems } from "./task-relation-lines";
import { TaskSection, type RelationPicker } from "./task-section";
import { TaskTrail } from "./task-trail";
import { useTaskRelationAccess, type DetailCommand } from "./use-task-relations";

export type TaskDetailMode = "split" | "expanded" | "sheet" | "drawer";

export type TaskDetailNavigation = {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
};

type TaskNavigationSetter = (navigation: TaskDetailNavigation | undefined) => void;

export const TaskNavigationRegistrationContext = createContext<TaskNavigationSetter | null>(null);

export function useRegisterTaskNavigation(navigation: TaskDetailNavigation | undefined) {
  const register = useContext(TaskNavigationRegistrationContext);
  useEffect(() => {
    if (!register) return;
    register(navigation);
    return () => register(undefined);
  }, [register, navigation]);
}

export type TaskDetailPanelProps = {
  task: TaskView;
  mode: TaskDetailMode;
  onClose: () => void;
  onCommand?: (command: DetailCommand) => Promise<void>;
  onDeleted?: () => void;
  conversationName?: string;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  thread?: (lead: ReactNode) => ReactNode;
  leadExtra?: ReactNode;
  onOpenRelated?: (task: VisibleTaskName) => void;
  navigation?: TaskDetailNavigation;
  expanded?: boolean;
  onToggleExpand?: () => void;
  detent?: "half" | "full";
  onToggleDetent?: () => void;
  onBeforeOpenPicker?: () => void;
  active?: boolean;
  closeOnEscape?: boolean;
  overlay?: boolean;
  titleSlot?: string;
};

const SHEET_BAR_BUTTON = "size-11 justify-center";

export function useTaskDetailModel({
  task,
  mode,
  onClose,
  onCommand,
  onDeleted,
  conversationName,
  members,
  currentMemberId,
  thread,
  leadExtra,
  onOpenRelated,
  navigation,
  expanded = false,
  onToggleExpand,
  detent,
  onToggleDetent,
  onBeforeOpenPicker,
  active = true,
  closeOnEscape = true,
  overlay = false,
  titleSlot,
}: TaskDetailPanelProps) {
  const deleteTask = useDeleteTask({
    task,
    onCommand,
    onDeleted: () => {
      onClose();
      onDeleted?.();
    },
  });
  const [picker, setPickerState] = useState<RelationPicker | null>(null);
  const [history, setHistory] = useState(false);
  const canDelete = useCanDeleteTask(task, currentMemberId);
  const relations = useTaskRelationAccess(task, currentMemberId);
  const follow = useTaskFollow(task, active && Boolean(thread) && ownsDiscussion(task));
  const wide = useMediaQuery("(min-width: 64rem)", true);
  const sidebar = mode === "expanded" && wide;
  const reduced = usePrefersReducedMotion();
  const router = useRouter();
  const step = useRouterState({ select: (state) => isTaskStep(state.location) });
  const stepBack = step ? () => router.history.back() : undefined;
  const rootRef = useRef<HTMLDivElement>(null);

  const setPicker = useCallback(
    (next: RelationPicker | null) => {
      if (next !== null) onBeforeOpenPicker?.();
      setPickerState(next);
    },
    [onBeforeOpenPicker],
  );

  const { setTitleElement, scrolledOut, canScrollToTop, scrollToTop } = useTaskLeadScroll({
    boundaryRef: rootRef,
    reducedMotion: reduced,
  });
  const showBackToTop = canScrollToTop && !history;

  const handleEscape = useCallback(
    (allowClose: boolean) => {
      if (history) {
        setHistory(false);
        return true;
      }
      if (stepBack) {
        stepBack();
        return true;
      }
      if (expanded && onToggleExpand) {
        onToggleExpand();
        return true;
      }
      if (allowClose) {
        onClose();
        return true;
      }
      return false;
    },
    [history, stepBack, expanded, onToggleExpand, onClose],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) {
        event.stopPropagation();
        return;
      }
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      const handled = handleEscape(!overlay && closeOnEscape);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [overlay, closeOnEscape, handleEscape],
  );

  useHotkey(
    "Escape",
    (event) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (overlay) {
        if (target !== document.body && target !== document.documentElement) return;
        const ownDialog =
          rootRef.current?.closest('[role="dialog"]') ??
          rootRef.current?.querySelector('[role="dialog"]');
        const overlays = document.querySelectorAll(OPEN_OVERLAY_SELECTOR);
        if (!ownDialog || overlays.item(overlays.length - 1) !== ownDialog) return;
        const handled = handleEscape(true);
        if (handled) event.preventDefault();
        return;
      }
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.matches("input, textarea, select"))
      )
        return;
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
      const handled = handleEscape(closeOnEscape);
      if (handled) event.preventDefault();
    },
    { enabled: active, preventDefault: false, ignoreInputs: false },
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
  const isSheet = mode === "sheet";
  const lead = (
    <div
      className={cn(
        "flex flex-col gap-5",
        sidebar ? "px-8 pt-6 pb-6" : isSheet ? "px-4 pt-3 pb-6" : "px-4 pt-4 pb-6 md:px-6",
      )}
    >
      <div className="flex flex-col gap-3">
        <Heading
          ref={setTitleElement}
          slot={titleSlot}
          level={2}
          className="text-xl font-semibold break-words text-primary"
        >
          {task.title}
        </Heading>
        {!sidebar && (
          <div className={cn(isSheet ? "-mx-4" : "-mx-4 md:-mx-6 md:[&_dl]:px-6")}>{section}</div>
        )}
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
      {leadExtra}
    </div>
  );
  const discussion = thread?.(lead);

  const header = (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1",
        isSheet ? "w-full min-w-0" : "h-12 border-b border-secondary pe-3 ps-2 sm:ps-3",
      )}
    >
      {navigation && !isSheet && (
        <div className="flex shrink-0 items-center">
          <ButtonUtility
            icon={ChevronUp}
            size="sm"
            color="tertiary"
            tooltip={m.tasks_panel_prev()}
            isDisabled={!navigation.hasPrev}
            onClick={navigation.onPrev}
          />
          <ButtonUtility
            icon={ChevronDown}
            size="sm"
            color="tertiary"
            tooltip={m.tasks_panel_next()}
            isDisabled={!navigation.hasNext}
            onClick={navigation.onNext}
          />
        </div>
      )}
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
          className={cn(
            "shrink-0 gap-1 px-1.5 text-xs font-medium whitespace-nowrap *:data-icon:size-4",
            isSheet && "h-11",
          )}
        >
          {m.tasks_scroll_to_top()}
        </Button>
      )}
      <Dropdown.Root>
        <ButtonUtility
          tooltip={isSheet ? undefined : m.tasks_more_actions({ number: String(task.number) })}
          {...(isSheet
            ? { "aria-label": m.tasks_more_actions({ number: String(task.number) }) }
            : {})}
          icon={MoreHorizontal}
          size="sm"
          color="tertiary"
          className={cn(isSheet && SHEET_BAR_BUTTON)}
        />
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            onAction={(key) => {
              if (key === "delete") void deleteTask();
              else if (key === "history") setHistory(true);
              else if (key === "parent" || key === "blocker" || key === "subtask") setPicker(key);
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
      {!isSheet && onToggleExpand && (
        <ButtonUtility
          icon={expanded ? Minimize02 : Maximize02}
          size="sm"
          color="tertiary"
          tooltip={expanded ? m.tasks_panel_restore() : m.tasks_panel_expand()}
          onClick={onToggleExpand}
        />
      )}
      {isSheet && onToggleDetent && (
        <ButtonUtility
          icon={detent === "full" ? Minimize02 : Maximize02}
          size="sm"
          color="tertiary"
          aria-label={detent === "full" ? m.tasks_sheet_collapse() : m.tasks_sheet_expand()}
          onClick={onToggleDetent}
          className={SHEET_BAR_BUTTON}
        />
      )}
      <ButtonUtility
        icon={XClose}
        size="sm"
        color="tertiary"
        tooltip={isSheet ? undefined : m.tasks_close()}
        {...(isSheet ? { "aria-label": m.tasks_close() } : {})}
        onClick={onClose}
        className={cn(isSheet && SHEET_BAR_BUTTON)}
      />
    </div>
  );

  const body = (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {history ? (
          <TaskHistoryPage task={task} members={members} onBack={() => setHistory(false)} />
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
  );

  return {
    rootRef,
    header,
    body,
    onKeyDown,
    keyboardDismiss: !step && !history && !expanded,
    hasHistory: history,
  };
}

export function TaskDetailPanel(props: TaskDetailPanelProps) {
  const { rootRef, header, body, onKeyDown } = useTaskDetailModel(props);
  return (
    <section
      ref={rootRef}
      aria-label={m.tasks_details_title({ number: String(props.task.number) })}
      onKeyDown={onKeyDown}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary"
    >
      {header}
      {body}
    </section>
  );
}
