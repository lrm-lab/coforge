import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import { DotsGrid } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
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
  | { type: "group"; section: `custom:${string}`; label: string };

/** dnd-kit's multiple-container pattern: preview row placement on drag-over, keep an overlay
 * outside the scroll area, and persist only the placement the member actually drops. Custom
 * group headers use their own SortableContext in the same DndContext, so rows can reach them too. */
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
  sectionIds: readonly string[];
  commitPins: (change: NonNullable<ReturnType<typeof pinsAfterDrag>>) => void;
  commitSection: (change: NonNullable<ReturnType<typeof sectionChangeAfterDrag>>) => void;
  commitOrder: (ids: string[]) => void;
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
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
      const from = sectionIds.indexOf(String(event.active.id).slice("group:".length));
      const to = event.over ? sectionIds.indexOf(String(event.over.id).slice("group:".length)) : -1;
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
    }) => {
      start.current = base;
      setDragging(base);
      setActive({
        id: String(event.active.id),
        group: event.active.data.current?.type === "group",
        label: String(event.active.data.current?.label ?? ""),
        width: event.active.rect.current.initial?.width ?? 0,
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

/** Mouse users can drag the whole row. Touch/keyboard users get a handle so scrolling, link
 * activation and the existing long-press menu keep their ordinary behavior. */
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
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled, data: { type: "row", section, label } satisfies DragData });
  const dragged = useRef(false);
  if (isDragging) dragged.current = true;
  return (
    <li
      ref={setNodeRef}
      onPointerDownCapture={(event) => {
        dragged.current = false;
        if (
          event.pointerType === "mouse" &&
          (!(event.target instanceof Element) ||
            !event.target.closest("[data-directory-drag-handle]"))
        ) {
          listeners?.onPointerDown?.(event);
        }
      }}
      onClickCapture={(event) => {
        if (!dragged.current || event.detail === 0) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      data-dragging={isDragging || undefined}
      className="group/drag-row relative flex items-center rounded-md py-px select-none data-dragging:bg-primary_hover data-dragging:opacity-30"
      style={{
        transform: !isDragging && transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {!disabled && (
        <ButtonUtility
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          data-directory-drag-handle
          icon={DotsGrid}
          size="xs"
          color="tertiary"
          aria-label={m.chat_drag_conversation({ name: label })}
          tooltip={m.chat_drag_conversation({ name: label })}
          className="mr-1 shrink-0 touch-none cursor-grab opacity-0 group-hover/drag-row:opacity-100 group-focus-within/drag-row:opacity-100 any-pointer-coarse:opacity-100"
        />
      )}
    </li>
  );
}

export function DirectorySortableSection({
  id,
  label,
  disabled,
  children,
}: {
  id: string;
  label: string;
  disabled: boolean;
  children: (handle: ReactNode) => ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `group:${id}`,
    disabled,
    data: { type: "group", section: `custom:${id}`, label } satisfies DragData,
  });
  const handle = (
    <ButtonUtility
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      isDisabled={disabled}
      data-directory-drag-handle
      icon={DotsGrid}
      size="xs"
      color="tertiary"
      aria-label={m.chat_drag_section({ name: label })}
      tooltip={m.chat_drag_section({ name: label })}
      className="shrink-0 touch-none cursor-grab"
    />
  );
  return (
    <div
      ref={setNodeRef}
      className={cx("relative", isDragging && "opacity-30")}
      style={{
        transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      {children(handle)}
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
