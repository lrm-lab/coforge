import { useMemo, useRef, useState, type DOMAttributes, type ReactNode } from "react";
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
import { ChevronRight } from "@untitledui/icons";
import {
  DragRippleLine,
  rippleItemProps,
  rippleListProps,
  useDragRipple,
  type DragRipple,
} from "#src/components/ui/drag-ripple/drag-ripple";
import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import type { DirectorySectionId } from "./directory-sections";
import {
  canDropInto,
  moveInDirectory,
  pinsAfterDrag,
  sectionChangeAfterDrag,
  type DirectoryLayout,
  type HomeSection,
} from "./pinned-conversations";

type DragData =
  | { type: "row" | "section"; section: DirectorySectionId; label: string }
  | { type: "group"; section: DirectorySectionId; label: string };

const GROUPS = "groups";

const MOUSE_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };
const TOUCH_SENSOR_OPTIONS = { activationConstraint: { delay: 250, tolerance: 5 } };

export function useDirectoryDrag({
  layout,
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
  const [active, setActive] = useState<DirectoryDragActive | null>(null);
  const [hoveredSection, setHoveredSection] = useState<DirectorySectionId | null>(null);
  const isDragging = active !== null;
  useDocumentDragCursor(isDragging);
  const ripple = useDragRipple({
    axis: "y",
    amplitude: 8,
    keyboardFallback: sortableKeyboardCoordinates,
    signature: useMemo(() => JSON.stringify([sectionIds, layout]), [sectionIds, layout]),
  });
  const keyboardOptions = useMemo(
    () => ({
      coordinateGetter: ripple.keyboardCoordinates,
      keyboardCodes: { start: ["Space"], end: ["Space"], cancel: ["Escape"] },
    }),
    [ripple.keyboardCoordinates],
  );
  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, keyboardOptions),
  );
  const placedRow = (key: string, section: DirectorySectionId, gap: number) =>
    moveInDirectory(layout, natural, key, section, gap);
  const onDragMove = ({ active: item, over }: DragMoveEvent) => {
    setHoveredSection((over?.data.current as DragData | undefined)?.section ?? null);
    const rect = item.rect.current.translated;
    const key = String(item.id);
    if (item.data.current?.type === "group") return ripple.move(rect, [GROUPS]);
    ripple.move(
      rect,
      sectionIds.filter((section) => canDropInto(key, section)),
      ({ list, gap }) => {
        const section = list as DirectorySectionId;
        if (section === "pinned" || section.startsWith("custom:")) return gap;
        return placedRow(key, section, gap)[section].indexOf(key);
      },
    );
  };
  const reset = () => {
    setActive(null);
    setHoveredSection(null);
  };
  const onDragEnd = ({ active: item }: DragEndEvent) => {
    const placed = ripple.end(true);
    reset();
    if (!placed) return;
    if (item.data.current?.type === "group") {
      const from = sectionIds.indexOf(String(item.id).slice("group:".length) as DirectorySectionId);
      if (from >= 0) commitOrder(arrayMove([...sectionIds], from, placed.gap));
      return;
    }
    const key = String(item.id);
    const released = placedRow(key, placed.list as DirectorySectionId, placed.gap);
    const section = sectionChangeAfterDrag(layout, released, key);
    const pins = pinsAfterDrag(layout, released);
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
      };
      activatorEvent: Event | null;
    }) => {
      const group = event.active.data.current?.type === "group";
      const section = event.active.data.current?.section as DirectorySectionId;
      ripple.begin(group ? GROUPS : section, String(event.active.id));
      setActive({
        id: String(event.active.id),
        group,
        label: String(event.active.data.current?.label ?? ""),
        origin: pressedRect(event.activatorEvent?.target ?? null),
      });
    },
    onDragMove,
    onDragEnd,
    onDragCancel: () => {
      ripple.end(false);
      reset();
    },
  };
  return {
    context,
    ripple,
    dragging: isDragging,
    active,
    hoveredSection,
    sortingSections: active?.group === true,
  };
}

type DirectoryDragActive = {
  id: string;
  group: boolean;
  label: string;
  origin: { top: number; left: number; width: number } | null;
};

function pressedRect(target: EventTarget | null): DirectoryDragActive["origin"] {
  if (!(target instanceof Element)) return null;
  const item = target.closest("[data-chat-section-sortable], li");
  if (!item) return null;
  const { top, left, width } = item.getBoundingClientRect();
  return { top, left, width };
}

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
  ripple,
  section,
  keys,
  label,
  children,
}: {
  ripple: DragRipple;
  section: DirectorySectionId;
  keys: readonly string[];
  label: string;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: `section:${section}`,
    data: { type: "section", section, label } satisfies DragData,
  });
  const list = rippleListProps(ripple, section);
  return (
    <SortableContext id={section} items={[...keys]} strategy={verticalListSortingStrategy}>
      <ul
        {...list}
        ref={(node) => {
          setNodeRef(node);
          list.ref(node);
        }}
        aria-label={label}
        className="relative flex min-h-9 flex-col rounded-md"
      >
        {children}
        <DragRippleLine ripple={ripple} list={section} className="text-primary" />
      </ul>
    </SortableContext>
  );
}

export function DirectorySectionList({
  ripple,
  children,
}: {
  ripple: DragRipple;
  children: ReactNode;
}) {
  return (
    <div {...rippleListProps(ripple, GROUPS)} className="relative">
      {children}
      <DragRippleLine ripple={ripple} list={GROUPS} className="text-primary" />
    </div>
  );
}

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

export function DirectoryDragRow({
  ripple,
  id,
  section,
  disabled,
  label,
  children,
}: {
  ripple: DragRipple;
  id: string;
  section: DirectorySectionId;
  disabled: boolean;
  label: string;
  children: ReactNode;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useSortable({
    id,
    disabled,
    data: { type: "row", section, label } satisfies DragData,
  });
  const activation = useItemDragActivation(listeners, isDragging);
  return (
    <li
      ref={setNodeRef}
      {...activation}
      {...rippleItemProps(ripple, section, id)}
      tabIndex={disabled ? undefined : 0}
      aria-label={label}
      aria-describedby={attributes["aria-describedby"]}
      className="relative rounded-md py-px touch-manipulation outline-focus-ring select-none focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {children}
    </li>
  );
}

export function DirectorySortableSection({
  ripple,
  id,
  label,
  disabled,
  className,
  children,
}: {
  ripple: DragRipple;
  id: DirectorySectionId;
  className?: string;
  label: string;
  disabled: boolean;
  children: (headingProps: DirectoryDragActivation) => ReactNode;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useSortable({
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
      {...rippleItemProps(ripple, GROUPS, `group:${id}`)}
      className={cx(
        "relative touch-manipulation outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2",
        className,
      )}
    >
      {children({ ...activation, "aria-describedby": attributes["aria-describedby"] })}
    </div>
  );
}

export function DirectoryDragOverlay({
  ripple,
  active,
  children,
}: {
  ripple: DragRipple;
  active: DirectoryDragActive | null;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null;
  const origin = active?.origin;
  return createPortal(
    <DragOverlay
      dropAnimation={ripple.dropAnimation}
      style={origin ? { top: origin.top, left: origin.left } : undefined}
      className="pointer-events-none"
    >
      {active ? (
        <div
          aria-hidden="true"
          data-directory-drag-overlay
          style={{ width: origin?.width, ...ripple.liftStyle }}
          className="rounded-md bg-primary p-1 shadow-lg ring-1 ring-secondary"
        >
          {active.group ? (
            <span className="flex h-9 items-center gap-1.5 px-4">
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
              </span>
              <span className="min-w-0 truncate text-sm font-medium text-primary">
                {active.label}
              </span>
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
