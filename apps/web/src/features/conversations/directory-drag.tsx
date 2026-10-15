import { useRef, useState, type DOMAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import type { DirectorySectionId } from "./directory-sections";
import {
  canDropInto,
  dropTarget,
  moveInDirectory,
  pinsAfterDrag,
  sectionChangeAfterDrag,
  type DirectoryLayout,
  type HomeSection,
} from "./pinned-conversations";

type DragData =
  | { type: "row" | "section"; section: DirectorySectionId; label: string }
  | { type: "group"; section: DirectorySectionId; label: string };

/** dnd-kit's multiple-container pattern: preview row placement on drag-over, keep an overlay
 * outside the scroll area, and persist only the placement the member actually drops. Section
 * headers (built-in and custom) use their own SortableContext in the same DndContext, so rows can
 * reach them too. `sectionIds` is the sections' order, top to bottom. */
export function useDirectoryDrag({
  layout: base,
  natural,
  sectionIds,
  commitPins,
  commitSection,
  commitOrder,
}: {
  layout: DirectoryLayout;
  natural: Record<HomeSection, readonly string[]>;
  sectionIds: readonly DirectorySectionId[];
  commitPins: (change: NonNullable<ReturnType<typeof pinsAfterDrag>>) => void;
  commitSection: (change: NonNullable<ReturnType<typeof sectionChangeAfterDrag>>) => void;
  commitOrder: (order: DirectorySectionId[]) => void;
}) {
  const [dragging, setDragging] = useState<DirectoryLayout | null>(null);
  const [active, setActive] = useState<{
    id: string;
    group: boolean;
    label: string;
    width: number;
  } | null>(null);
  const [hoveredSection, setHoveredSection] = useState<DirectorySectionId | null>(null);
  const start = useRef<DirectoryLayout | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], end: ["Space"], cancel: ["Escape"] },
    }),
  );
  const layout = dragging ?? base;
  const moved = (current: DirectoryLayout, { active: item, over }: DragMoveEvent) => {
    const data = over?.data.current as DragData | undefined;
    if (!over || !data || item.data.current?.type === "group") return current;
    const rect = item.rect.current.translated;
    const to = dropTarget(
      current,
      String(item.id),
      {
        key: String(over.id),
        section: data.section,
        type: data.type === "row" ? "row" : "section",
      },
      rect
        ? { dragged: rect.top + rect.height / 2, over: over.rect.top + over.rect.height / 2 }
        : null,
    );
    return to ? moveInDirectory(current, natural, String(item.id), to.section, to.index) : current;
  };
  const relayout = (event: DragMoveEvent) => {
    const data = event.over?.data.current as DragData | undefined;
    setHoveredSection(data?.section ?? null);
    const current = dragging ?? base;
    const next = moved(current, event);
    if (next !== current) setDragging(next);
  };
  const reset = () => {
    start.current = null;
    setDragging(null);
    setActive(null);
    setHoveredSection(null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const before = start.current ?? base;
    if (event.active.data.current?.type === "group") {
      const keyOf = (id: string | number) =>
        String(id).slice("group:".length) as DirectorySectionId;
      const from = sectionIds.indexOf(keyOf(event.active.id));
      const to = event.over ? sectionIds.indexOf(keyOf(event.over.id)) : -1;
      reset();
      if (from >= 0 && to >= 0 && from !== to) commitOrder(arrayMove([...sectionIds], from, to));
      return;
    }
    const released = event.over ? moved(dragging ?? base, event) : before;
    const section = sectionChangeAfterDrag(before, released, String(event.active.id));
    const pins = pinsAfterDrag(before, released);
    reset();
    if (section) commitSection(section);
    else if (pins) commitPins(pins);
  };
  const context = {
    sensors,
    collisionDetection: directoryCollision,
    measuring: { droppable: { strategy: MeasuringStrategy.Always } },
    accessibility: {
      screenReaderInstructions: { draggable: m.chat_drag_instructions() },
      announcements: {
        onDragStart: ({
          active: item,
        }: {
          active: { data: { current?: Record<string, unknown> } };
        }) => m.chat_drag_start({ name: String(item.data.current?.label ?? "") }),
        onDragEnd: () => m.chat_drag_end(),
        onDragOver: ({ over }: DragOverEvent) =>
          over ? m.chat_drag_over({ name: String(over.data.current?.label ?? "") }) : undefined,
        onDragCancel: () => m.chat_drag_cancel(),
      },
    },
    onDragStart: (event: {
      active: {
        id: string | number;
        data: { current?: Record<string, unknown> };
        rect: { current: { initial: { width: number } | null } };
      };
      activatorEvent: Event | null;
    }) => {
      start.current = base;
      setDragging(base);
      setActive({
        id: String(event.active.id),
        group: event.active.data.current?.type === "group",
        label: String(event.active.data.current?.label ?? ""),
        // dnd-kit measures `rect.initial` after this callback, so it is still empty here: the
        // overlay takes the width of the row or section that was pressed instead.
        width:
          event.active.rect.current.initial?.width ||
          draggedWidth(event.activatorEvent?.target ?? null),
      });
    },
    onDragOver: relayout,
    onDragMove: relayout,
    onDragEnd,
    onDragCancel: reset,
  };
  return {
    layout,
    context,
    dragging: active !== null,
    active,
    hoveredSection,
    sortingSections: active?.group === true,
  };
}

/** The width of the row (`li`) or section that a drag started on, from the pressed element. */
function draggedWidth(target: EventTarget | null): number {
  if (!(target instanceof Element)) return 0;
  const item = target.closest("[data-chat-section-sortable], li");
  return item?.getBoundingClientRect().width ?? 0;
}

/** Pointer drops must be inside a valid target. Keyboard drags use closestCenter, as the
 * framework recommends; group sorting considers group headers only. Rows win over containers. */
const directoryCollision: CollisionDetection = (args) => {
  const group = args.active.data.current?.type === "group";
  const droppableContainers = args.droppableContainers.filter((container) => {
    const data = container.data.current as DragData | undefined;
    return (
      data && (group ? data.type === "group" : canDropInto(String(args.active.id), data.section))
    );
  });
  const scoped = { ...args, droppableContainers };
  if (group || !args.pointerCoordinates) return closestCenter(scoped);
  const hits = pointerWithin(scoped);
  const rows = hits.filter((hit) => hit.data?.droppableContainer.data.current?.type === "row");
  return rows.length > 0 ? rows : hits;
};

export function DirectoryDropList({
  section,
  keys,
  label,
  children,
}: {
  section: DirectorySectionId;
  keys: readonly string[];
  label: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `section:${section}`,
    data: { type: "section", section, label } satisfies DragData,
  });
  return (
    <SortableContext id={section} items={[...keys]} strategy={verticalListSortingStrategy}>
      <ul
        ref={setNodeRef}
        aria-label={label}
        className={cx(
          "flex min-h-9 flex-col rounded-md",
          isOver &&
            active &&
            canDropInto(String(active.id), section) &&
            "bg-primary_hover ring-1 ring-secondary",
        )}
      >
        {children}
      </ul>
    </SortableContext>
  );
}

/** Capture activates before React Aria handles the row/title press. A drag suppresses the
 * following click; a normal press still navigates or collapses. Touch movement before the
 * sensor's hold delay cancels activation, leaving list scrolling available. */
export type DirectoryDragActivation = Pick<
  DOMAttributes<HTMLElement>,
  "onMouseDownCapture" | "onTouchStartCapture" | "onKeyDownCapture" | "onClickCapture"
> & { "aria-describedby"?: string };

function useItemDragActivation(
  listeners: DraggableSyntheticListeners,
  isDragging: boolean,
): DirectoryDragActivation {
  const dragged = useRef(false);
  if (isDragging) dragged.current = true;
  return {
    onMouseDownCapture: (event) => {
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      dragged.current = false;
      listeners?.onMouseDown?.(event);
    },
    onTouchStartCapture: (event) => {
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      dragged.current = false;
      listeners?.onTouchStart?.(event);
    },
    onKeyDownCapture: (event) => {
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      if (event.target === event.currentTarget && event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.querySelector<HTMLElement>("a[href], button[aria-controls]")?.click();
        return;
      }
      listeners?.onKeyDown?.(event);
      if (event.defaultPrevented) event.stopPropagation();
    },
    onClickCapture: (event) => {
      if (!dragged.current || event.detail === 0) return;
      dragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

/** The conversation itself is draggable; it has no separate handle or tooltip. */
export function DirectoryDragRow({
  id,
  section,
  disabled,
  label,
  children,
}: {
  id: string;
  section: DirectorySectionId;
  disabled: boolean;
  label: string;
  children: ReactNode;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id,
    disabled,
    data: { type: "row", section, label } satisfies DragData,
  });
  const activation = useItemDragActivation(listeners, isDragging);
  return (
    <li
      ref={setNodeRef}
      {...activation}
      tabIndex={disabled ? undefined : 0}
      aria-label={label}
      aria-describedby={attributes["aria-describedby"]}
      data-dragging={isDragging || undefined}
      className="relative rounded-md py-px touch-manipulation outline-focus-ring select-none focus-visible:outline-2 focus-visible:outline-offset-2 data-dragging:bg-primary_hover data-dragging:opacity-30"
      style={{
        transform: !isDragging && transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      {children}
    </li>
  );
}

/** A section's title row is its drag activator: the collapse button of one that collapses, the
 * title itself of one that does not (Pinned). */
export function DirectorySortableSection({
  id,
  label,
  disabled,
  className,
  children,
}: {
  id: DirectorySectionId;
  /** The wrapper's own classes, e.g. hiding an empty section. */
  className?: string;
  label: string;
  disabled: boolean;
  children: (headingProps: DirectoryDragActivation) => ReactNode;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: `group:${id}`,
    disabled,
    data: { type: "group", section: id, label } satisfies DragData,
  });
  const { onKeyDownCapture, ...activation } = useItemDragActivation(listeners, isDragging);
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={label}
      aria-describedby={attributes["aria-describedby"]}
      tabIndex={disabled ? undefined : 0}
      onKeyDownCapture={(event) => {
        if (event.target === event.currentTarget) onKeyDownCapture?.(event);
      }}
      data-chat-section-sortable
      className={cx(
        "relative touch-manipulation outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2",
        isDragging && "opacity-30",
        className,
      )}
      style={{
        transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      {children({ ...activation, "aria-describedby": attributes["aria-describedby"] })}
    </div>
  );
}

/** Always mounted for the framework's drop animation; the preview is presentational, never a
 * second sortable item. Its measured width is the source row's width, independent of scroll. */
export function DirectoryDragOverlay({
  active,
  children,
}: {
  active: { group: boolean; label: string; width: number } | null;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <DragOverlay dropAnimation={{ duration: 150, easing: "ease-out" }}>
      {active ? (
        <div
          aria-hidden="true"
          data-directory-drag-overlay
          style={{ width: active.width }}
          className="pointer-events-none rounded-md bg-primary p-1 shadow-lg ring-1 ring-secondary"
        >
          {active.group ? (
            <span className="block truncate px-2 py-2 text-sm font-medium text-primary uppercase">
              {active.label}
            </span>
          ) : (
            children
          )}
        </div>
      ) : null}
    </DragOverlay>,
    document.body,
  );
}
