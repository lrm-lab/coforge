import { createContext, useContext, useId, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type Announcements,
  type DragMoveEvent,
} from "@dnd-kit/core";

import {
  DragRippleLine,
  DragRippleOverlay,
  rippleItemProps,
  rippleListProps,
  useDragRipple,
  type DragRipple,
} from "#src/components/ui/drag-ripple/drag-ripple";
import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

const TAB_DRAG_ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => m.chat_drag_start({ name: String(active.id) }),
  onDragOver: ({ over }) => (over ? m.chat_drag_over({ name: String(over.id) }) : undefined),
  onDragEnd: () => m.chat_drag_end(),
  onDragCancel: () => m.chat_drag_cancel(),
};

const TABS = "tabs";
const RippleContext = createContext<DragRipple | null>(null);

export function ReportTabDrag({
  order,
  onMove,
  className,
  children,
}: {
  order: readonly string[];
  onMove: (source: string, index: number) => void;
  className?: string;
  children: ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  useDocumentDragCursor(active !== null);
  const dndId = useId();
  const ripple = useDragRipple({ axis: "x", amplitude: 8, signature: order.join("\n") });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: ripple.keyboardCoordinates,
      keyboardCodes: { start: ["Space"], end: ["Space", "Enter"], cancel: ["Escape"] },
    }),
  );
  const follow = ({ active: tab }: DragMoveEvent) =>
    ripple.move(tab.rect.current.translated, [TABS]);
  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      accessibility={{ announcements: TAB_DRAG_ANNOUNCEMENTS }}
      onDragStart={({ active: tab }) => {
        setActive(String(tab.id));
        ripple.begin(TABS, String(tab.id));
      }}
      onDragMove={follow}
      onDragCancel={() => {
        ripple.end(false);
        setActive(null);
      }}
      onDragEnd={({ active: tab }) => {
        const placed = ripple.end(true);
        setActive(null);
        if (placed) onMove(String(tab.id), placed.gap);
      }}
    >
      <RippleContext.Provider value={ripple}>
        <div
          {...rippleListProps(ripple, TABS)}
          className={cn("relative flex shrink-0 items-center", className)}
        >
          {children}
          <DragRippleLine ripple={ripple} list={TABS} className="text-primary" />
        </div>
      </RippleContext.Provider>
      <DragRippleOverlay ripple={ripple}>
        {active ? (
          <div
            aria-hidden="true"
            style={ripple.liftStyle}
            className="w-max rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary shadow-lg ring-1 ring-secondary"
          >
            {active}
          </div>
        ) : null}
      </DragRippleOverlay>
    </DndContext>
  );
}

export type ReportTabPress = { pressStart: () => void; dragged: () => boolean };

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
  const ripple = useContext(RippleContext);
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: name, disabled });
  const dragged = useRef(false);
  if (isDragging) dragged.current = true;
  const pressStart = () => {
    dragged.current = false;
  };
  return (
    <div
      ref={setNodeRef}
      {...(ripple ? rippleItemProps(ripple, TABS, name) : undefined)}
      onMouseDownCapture={(event) => {
        pressStart();
        listeners?.onMouseDown?.(event);
      }}
      onTouchStartCapture={(event) => {
        pressStart();
        listeners?.onTouchStart?.(event);
      }}
      onKeyDownCapture={(event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-report-tab]"))
          return;
        listeners?.onKeyDown?.(event);
        if (event.defaultPrevented) event.stopPropagation();
      }}
      onClickCapture={(event) => {
        if (!dragged.current || event.detail === 0) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn("select-none [-webkit-touch-callout:none]", className)}
    >
      {children({ pressStart, dragged: () => dragged.current })}
    </div>
  );
}
