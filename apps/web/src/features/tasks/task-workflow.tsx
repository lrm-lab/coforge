import {
  TASK_WRITE_STATUSES,
  isTaskWriteStatus,
  TASK_READ_STATUSES,
  compareTaskOrder,
  type TaskStatus,
  type TaskWriteStatus,
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
  type DropAnimationFunction,
} from "@dnd-kit/core";
import { useHydrated } from "@tanstack/react-router";
import { DotsGrid as GripVertical } from "@untitledui/icons";
import { LayoutGroup, motion } from "motion/react";
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { flyOverlay, liftFor } from "#src/components/ui/drag-ripple/drag-ripple";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { DURATION_S, EASE_IN_OUT } from "#src/utils/motion-tokens";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { DropState } from "./task-drop-target";
import { HiddenColumn, TaskGroup, type PagedTaskGroup } from "./task-group";
import { getTaskMoveCommand } from "./task-move";

export type TaskLayout = "board" | "list";
export type TaskMoveCommand = NonNullable<ReturnType<typeof getTaskMoveCommand>>;
export type TaskControls = {
  handle: ReactNode;
  moves: { status: TaskWriteStatus; onMove: () => void }[];
};

export type { PagedTaskGroup };

export function useTaskLayout(layout: TaskLayout | undefined): TaskLayout {
  const hydrated = useHydrated();
  const desktop = useBreakpoint("md");
  return layout ?? (!hydrated || desktop ? "board" : "list");
}

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };

export function TaskWorkflow<T extends TaskView>({
  tasks,
  layout,
  statuses = tasks.some((task) => task.status === "backlog")
    ? TASK_READ_STATUSES
    : TASK_WRITE_STATUSES,
  currentMemberId,
  canSetAnyStatus = false,
  disabled,
  commandsPending = false,
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
  hidden?: ReadonlySet<TaskStatus>;
  onHiddenChange?: (status: TaskStatus, hidden: boolean) => void;
  currentMemberId: (task: T) => string | null;
  canSetAnyStatus?: boolean;
  disabled?: boolean;
  commandsPending?: boolean;
  onMove: (task: T, command: TaskMoveCommand) => Promise<void>;
  renderTask: (task: T, controls: TaskControls) => ReactNode;
  showMoveError: boolean;
  adding?: { statuses: readonly TaskWriteStatus[]; onAdd: (status: TaskWriteStatus) => void };
}) {
  const id = useId();
  const [active, setActive] = useState<T>();
  const [landing, setLanding] = useState<string>();
  const reduced = usePrefersReducedMotion();
  useDocumentDragCursor(active !== undefined);
  const dropAnimation: DropAnimationFunction = async ({
    active: card,
    dragOverlay,
    transform,
    draggableNodes,
  }) => {
    await new Promise(requestAnimationFrame);
    const rect = draggableNodes.get(card.id)?.node.current?.getBoundingClientRect();
    if (rect) await flyOverlay(dragOverlay, transform, { x: rect.left, y: rect.top });
    setLanding(undefined);
  };
  const [pending, setPending] = useState<{
    id: string;
    revision: number;
    status: TaskWriteStatus;
  }>();
  const [byPriority, setByPriority] = useState<ReadonlySet<TaskStatus>>(new Set());
  const saving = useRef(false);
  const [error, setError] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor),
  );
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
    byPriority.has(group.status) ? [...group.tasks].sort(compareTaskOrder) : group.tasks;

  const hides = layout === "board" && groups.length > 1 && hidden !== undefined;
  const shownGroups = hides ? groups.filter((group) => !hidden.has(group.status)) : groups;
  const hiddenGroups = hides ? groups.filter((group) => hidden.has(group.status)) : [];
  const dropState = (status: TaskStatus): DropState => {
    if (!active || status === active.status) return "idle";
    if (!isTaskWriteStatus(status)) return "blocked";
    const open =
      !disabled &&
      !pending &&
      getTaskMoveCommand(active, currentMemberId(active), status, { canSetAnyStatus });
    return open ? "open" : "blocked";
  };

  const moveTask = useLatestCallback(move);
  const builtControls = useRef(
    new Map<string, { task: T; signature: string; controls: TaskControls }>(),
  );
  const buildControls = (task: T, inert: boolean): TaskControls => {
    if (disabled && !commandsPending) return { handle: null, moves: [] };
    const moves = TASK_WRITE_STATUSES.filter((status) =>
      getTaskMoveCommand(task, currentMemberId(task), status, { canSetAnyStatus }),
    ).map((status) => ({ status, onMove: () => void moveTask(task, status) }));
    if (moves.length === 0) return { handle: null, moves };
    return {
      handle: <DragHandle task={task} disabled={inert} />,
      moves: inert ? [] : moves,
    };
  };
  const controls = (task: T): TaskControls => {
    const inert = Boolean(pending) || Boolean(disabled);
    const signature = `${disabled}|${commandsPending}|${canSetAnyStatus}|${inert}`;
    const built = builtControls.current.get(task.id);
    if (built?.task === task && built.signature === signature) return built.controls;
    const fresh = buildControls(task, inert);
    builtControls.current.set(task.id, { task, signature, controls: fresh });
    return fresh;
  };

  const add = (status: TaskStatus) =>
    adding && isTaskWriteStatus(status) && adding.statuses.includes(status)
      ? () => adding.onAdd(status)
      : undefined;

  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={dropTarget}
      onDragStart={({ active: item }) => setActive(tasks.find((task) => task.id === item.id))}
      onDragCancel={() => {
        if (!reduced) setLanding(active?.id);
        setActive(undefined);
      }}
      onDragEnd={(event) => void dropped(event)}
    >
      {error && showMoveError && (
        <p role="alert" className="mb-4 text-sm text-error-primary">
          {m.tasks_mutation_error()}
        </p>
      )}
      <LayoutGroup id={`tasks-${id}`}>
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
              compact={groups.length > TASK_WRITE_STATUSES.length}
              dropState={dropState(group.status)}
              hidable={hides}
              onHide={
                hides && onHiddenChange ? () => onHiddenChange(group.status, true) : undefined
              }
              onAdd={add(group.status)}
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
                    .map((task) => {
                      const canAnimate = !reduced && active === undefined && landing === undefined;
                      return (
                        <motion.div
                          key={task.id}
                          layout={canAnimate ? "position" : false}
                          layoutId={canAnimate ? `task-item-${id}-${task.id}` : undefined}
                          transition={{
                            layout: { duration: DURATION_S.md, ease: EASE_IN_OUT },
                          }}
                          data-task-drag-node
                          aria-busy={pending?.id === task.id}
                          className={cn(landing === task.id && "opacity-0")}
                        >
                          {renderTask(task, controls(task))}
                        </motion.div>
                      );
                    })}
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
      </LayoutGroup>
      <DragOverlay dropAnimation={reduced ? null : dropAnimation} className="pointer-events-none">
        {active ? (
          <div
            style={reduced ? undefined : liftFor("y")}
            className={cn(
              "size-full overflow-hidden rounded-lg border border-secondary bg-primary shadow-lg",
              layout === "list" ? "flex items-center gap-2 px-3" : "p-3",
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

  async function move(task: T, status: TaskWriteStatus) {
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
    if (!reduced) setLanding(task?.id);
    setActive(undefined);
    if (!task || !event.over) return;
    const status = parseTaskStatus(String(event.over.id));
    if (status) await move(task, status);
  }
}

const dropTarget: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

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

export { TASK_STATUS_COLOR, statusLabel, taskStatusColor } from "./task-status-icon";

function parseTaskStatus(value: string | null): TaskWriteStatus | undefined {
  return TASK_WRITE_STATUSES.find((status) => status === value);
}
