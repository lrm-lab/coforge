import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
} from "@dnd-kit/core";

import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/** Screen-reader announcements for a tab drag; a tab's id is its name. */
const TAB_DRAG_ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => m.chat_drag_start({ name: String(active.id) }),
  onDragOver: ({ over }) => (over ? m.chat_drag_over({ name: String(over.id) }) : undefined),
  onDragEnd: ({ over }) => (over ? m.chat_drag_end() : m.chat_drag_cancel()),
  onDragCancel: () => m.chat_drag_cancel(),
};

/**
 * Drag-to-reorder for a report's page tabs ([dnd-kit](https://docs.dndkit.com)): a tab dropped on
 * another tab moves in front of it. The tab stays in place, dimmed, while an overlay follows the
 * pointer. A mouse drag starts after 6px of movement so a click still selects and a double click
 * still renames; a touch drag starts after a 250ms press so a swipe still scrolls the strip
 * ([sensors](https://docs.dndkit.com/api-documentation/sensors)), as in `ReorderableTabStrip`.
 */
export function ReportTabDrag({
  onMove,
  children,
}: {
  onMove: (source: string, target: string) => void;
  children: ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  useDocumentDragCursor(active !== null);
  const dndId = useId();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={pointerWithin}
      accessibility={{ announcements: TAB_DRAG_ANNOUNCEMENTS }}
      onDragStart={({ active: tab }) => setActive(String(tab.id))}
      onDragCancel={() => setActive(null)}
      onDragEnd={({ active: tab, over }) => {
        setActive(null);
        if (over) onMove(String(tab.id), String(over.id));
      }}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {active ? (
          <div
            aria-hidden="true"
            className="w-max rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary shadow-lg ring-1 ring-secondary"
          >
            {active}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** What a draggable tab's own button needs: `pressStart` for its `onPressStart`, and `dragged()`,
 * true when the press now ending finished a drag of this tab. */
export type ReportTabPress = { pressStart: () => void; dragged: () => boolean };

/** One tab with its delete button: the drag source and the drop target for the tab `name`. */
export function ReportTabDragItem({
  name,
  disabled,
  className,
  children,
}: {
  name: string;
  disabled: boolean;
  className?: string;
  children: (press: ReportTabPress) => ReactNode;
}) {
  const { setNodeRef: setDragNode, listeners, isDragging } = useDraggable({ id: name, disabled });
  const { setNodeRef: setDropNode } = useDroppable({ id: name });
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setDragNode(node);
      setDropNode(node);
    },
    [setDragNode, setDropNode],
  );
  // Releasing a drag on its own tab is also a press on it (or a click on its delete button); that
  // press is swallowed so a drop only reorders. The next press clears the flag: the tab's own
  // `onPressStart` (keyboard and screen-reader presses too), or any mouse or touch press here.
  const dragged = useRef(false);
  if (isDragging) dragged.current = true;
  const pressStart = () => {
    dragged.current = false;
  };
  return (
    <div
      ref={ref}
      // The tab handles its own press events and stops them from bubbling, so the sensors listen
      // in the capture phase instead.
      onMouseDownCapture={(event) => {
        pressStart();
        listeners?.onMouseDown?.(event);
      }}
      onTouchStartCapture={(event) => {
        pressStart();
        listeners?.onTouchStart?.(event);
      }}
      onClickCapture={(event) => {
        if (!dragged.current || event.detail === 0) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        "select-none [-webkit-touch-callout:none]",
        className,
        isDragging && "opacity-50",
      )}
    >
      {children({ pressStart, dragged: () => dragged.current })}
    </div>
  );
}
