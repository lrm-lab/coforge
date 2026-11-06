import {
  TASK_STATUSES,
  taskPriorityRank,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useHydrated } from "@tanstack/react-router";
import { DotsGrid as GripVertical } from "@untitledui/icons";
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { DropState } from "./task-drop-target";
import { HiddenColumn, TaskGroup, type PagedTaskGroup } from "./task-group";
import { getTaskMoveCommand } from "./task-move";

export type TaskLayout = "board" | "list";
export type TaskMoveCommand = NonNullable<ReturnType<typeof getTaskMoveCommand>>;
/** The drag handle and the "Move to" choices a card's menu offers; both carry every move the
 * server allows, while the popup's status menu keeps to `STATUS_TRANSITIONS`. */
export type TaskControls = {
  handle: ReactNode;
  moves: { status: TaskStatus; onMove: () => void }[];
};

export type { PagedTaskGroup };

export function useTaskLayout(layout: TaskLayout | undefined): TaskLayout {
  // Keep SSR and initial hydration identical (board); the viewport default applies once hydrated.
  const hydrated = useHydrated();
  const desktop = useBreakpoint("md");
  return layout ?? (!hydrated || desktop ? "board" : "list");
}

export function TaskWorkflow<T extends TaskView>({
  tasks,
  layout,
  statuses = TASK_STATUSES,
  currentMemberId,
  canSetAnyStatus = false,
  disabled,
  onMove,
  renderTask,
  paged,
  hidden,
  onHiddenChange,
  showMoveError,
  adding,
}: {
  tasks: readonly T[];
  layout: TaskLayout;
  statuses?: readonly TaskStatus[];
  paged?: Partial<Record<TaskStatus, PagedTaskGroup>>;
  /** Board columns the viewer hid: listed last, still drop targets; the list shows them all. */
  hidden?: ReadonlySet<TaskStatus>;
  /** Hides or shows a board column; given, each column's menu offers "Hide column". */
  onHiddenChange?: (status: TaskStatus, hidden: boolean) => void;
  currentMemberId: (task: T) => string | null;
  /** The viewer sets any Task status (a Workspace owner or admin), so the board offers every
   * move the server accepts, not only the ordinary transitions. */
  canSetAnyStatus?: boolean;
  disabled?: boolean;
  onMove: (task: T, command: TaskMoveCommand) => Promise<void>;
  renderTask: (task: T, controls: TaskControls) => ReactNode;
  /** False where the page already says a refused command failed (a conversation's board), so a
   * refused move is not said twice. */
  showMoveError: boolean;
  /** Starts a new Task in a board column: the statuses that take one, and what opens the form. */
  adding?: { statuses: readonly TaskStatus[]; onAdd: (status: TaskStatus) => void };
}) {
  const id = useId();
  const [active, setActive] = useState<T>();
  useDocumentDragCursor(active !== undefined);
  const [pending, setPending] = useState<{
    id: string;
    revision: number;
    status: TaskStatus;
  }>();
  // Columns the viewer ordered by priority, a view of the loaded cards only: the default order
  // is the server's and returns when it is switched off.
  const [byPriority, setByPriority] = useState<ReadonlySet<TaskStatus>>(new Set());
  const saving = useRef(false);
  const [error, setError] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  // Drag-over re-renders the board constantly; only regroup when the inputs change.
  const groups = useMemo(() => {
    const displayedTasks = tasks.map((task) =>
      pending?.id === task.id && pending.revision === task.revision
        ? { ...task, status: pending.status }
        : task,
    );
    return statuses.map((status) => ({
      status,
      tasks: displayedTasks.filter((task) => task.status === status),
    }));
  }, [tasks, pending, statuses]);
  const ordered = (group: (typeof groups)[number]) =>
    byPriority.has(group.status)
      ? [...group.tasks].sort((a, b) => taskPriorityRank(a.priority) - taskPriorityRank(b.priority))
      : group.tasks;

  // Hiding applies to a board of several columns; a single-status view shows its column.
  const hides = layout === "board" && groups.length > 1 && hidden !== undefined;
  const shownGroups = hides ? groups.filter((group) => !hidden.has(group.status)) : groups;
  const hiddenGroups = hides ? groups.filter((group) => hidden.has(group.status)) : [];
  // While a card is carried, a column it can go to takes the drop and lights up; one it cannot
  // says so before the drop (its contents fade, the pointer over it reads "not allowed",
  // `dropTargetClass`). Its own column stays idle.
  const dropState = (status: TaskStatus): DropState => {
    if (!active || status === active.status) return "idle";
    const open =
      !disabled &&
      !pending &&
      getTaskMoveCommand(active, currentMemberId(active), status, { canSetAnyStatus });
    return open ? "open" : "blocked";
  };

  const controls = (task: T): TaskControls => {
    if (disabled) return { handle: null, moves: [] };
    const moves = TASK_STATUSES.filter((status) =>
      getTaskMoveCommand(task, currentMemberId(task), status, { canSetAnyStatus }),
    ).map((status) => ({ status, onMove: () => void move(task, status) }));
    if (moves.length === 0) return { handle: null, moves };
    const isPending = Boolean(pending);
    return {
      handle: <DragHandle task={task} disabled={isPending} />,
      moves: isPending ? [] : moves,
    };
  };

  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={dropTarget}
      onDragStart={({ active: item }) => setActive(tasks.find((task) => task.id === item.id))}
      onDragCancel={() => setActive(undefined)}
      onDragEnd={(event) => void dropped(event)}
    >
      {error && showMoveError && (
        <p role="alert" className="mb-4 text-sm text-error-primary">
          {m.tasks_mutation_error()}
        </p>
      )}
      <div
        className={
          layout === "list"
            ? "flex flex-col gap-4"
            : groups.length > 1
              ? "flex flex-col gap-3 md:h-full md:flex-row md:items-stretch md:justify-center-safe md:overflow-x-auto"
              : "flex max-w-sm flex-col md:h-full"
        }
      >
        {shownGroups.map((group) => (
          <TaskGroup
            key={group.status}
            status={group.status}
            count={paged?.[group.status]?.count ?? group.tasks.length}
            loaded={group.tasks.length}
            paged={paged?.[group.status]}
            board={layout === "board"}
            dropState={dropState(group.status)}
            hidable={hides}
            onHide={hides && onHiddenChange ? () => onHiddenChange(group.status, true) : undefined}
            onAdd={
              adding?.statuses.includes(group.status) ? () => adding.onAdd(group.status) : undefined
            }
            onSortByPriority={(on) =>
              setByPriority((current) => {
                const next = new Set(current);
                if (on) next.add(group.status);
                else next.delete(group.status);
                return next;
              })
            }
            sortedByPriority={byPriority.has(group.status)}
          >
            {(shown) => (
              <>
                {ordered(group)
                  .slice(0, shown)
                  .map((task) => (
                    <div key={task.id} data-task-drag-node aria-busy={pending?.id === task.id}>
                      {renderTask(task, controls(task))}
                    </div>
                  ))}
              </>
            )}
          </TaskGroup>
        ))}
        {hiddenGroups.length > 0 && (
          <aside
            aria-label={m.tasks_hidden_columns()}
            className="flex shrink-0 flex-col gap-1 md:w-52"
          >
            <h2 className="flex h-10 items-center px-1 text-sm font-medium text-tertiary">
              {m.tasks_hidden_columns()}
            </h2>
            {hiddenGroups.map((group) => (
              <HiddenColumn
                key={group.status}
                status={group.status}
                count={paged?.[group.status]?.count ?? group.tasks.length}
                dropState={dropState(group.status)}
                onShow={() => onHiddenChange?.(group.status, false)}
              />
            ))}
          </aside>
        )}
      </div>
      {/* The overlay takes the dragged card's own box: a board card's, or a list row's, so it
          stays under the pointer either way. dnd-kit leaves it hit-testable; it takes no pointer
          events, so the pointer reads the column beneath it: "not allowed" over one it cannot go
          to. */}
      <DragOverlay dropAnimation={null} className="pointer-events-none">
        {active ? (
          <div
            className={cn(
              "size-full overflow-hidden rounded-lg border border-secondary bg-primary shadow-lg",
              layout === "list" ? "flex items-center gap-2 px-3" : "rotate-2 p-3",
            )}
          >
            <span className="text-xs font-medium text-tertiary tabular-nums">#{active.number}</span>
            <p
              className={cn(
                "text-sm font-medium text-primary",
                layout === "list" ? "truncate" : "mt-1 line-clamp-3",
              )}
            >
              {active.title}
            </p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );

  async function move(task: T, status: TaskStatus) {
    if (disabled || saving.current) return;
    const command = getTaskMoveCommand(task, currentMemberId(task), status, { canSetAnyStatus });
    if (!command) return;
    saving.current = true;
    setError(false);
    setPending({ id: task.id, revision: task.revision, status });
    try {
      await onMove(task, command);
    } catch {
      setError(true);
    } finally {
      saving.current = false;
      setPending(undefined);
    }
  }
  async function dropped(event: DragEndEvent) {
    const task = active;
    setActive(undefined);
    if (!task || !event.over) return;
    const status = parseTaskStatus(String(event.over.id));
    if (status) await move(task, status);
  }
}

/** A pointer drag drops where the pointer is, not where the dragged card overlaps most; a
 * keyboard drag, which has no pointer, keeps dnd-kit's default and goes by overlap. */
const dropTarget: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

/** The grip that picks a card up. The card around it is what is dragged, so its overlay starts
 * where the card stood; the grip registers it rather than the card registering itself, so a drag
 * moving between columns re-renders the grips, not each card's whole content. */
function DragHandle({ task, disabled }: { task: TaskView; disabled: boolean }) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes } = useDraggable({
    id: task.id,
    disabled,
  });
  const ref = useCallback(
    (handle: HTMLElement | null) => {
      setActivatorNodeRef(handle);
      setNodeRef(handle?.closest<HTMLElement>("[data-task-drag-node]") ?? null);
    },
    [setNodeRef, setActivatorNodeRef],
  );
  return (
    <ButtonUtility
      ref={ref}
      {...listeners}
      {...attributes}
      size="xs"
      color="tertiary"
      isDisabled={disabled}
      icon={GripVertical}
      aria-label={m.tasks_drag({ number: String(task.number) })}
      className="touch-none"
    />
  );
}

// The status colours and labels live with the icon; the popup and timeline read them from here too.
export { TASK_STATUS_COLOR, statusLabel } from "./task-status-icon";

function parseTaskStatus(value: string | null): TaskStatus | undefined {
  return TASK_STATUSES.find((status) => status === value);
}
