import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useLocale } from "react-aria-components";

import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import {
  DragRippleLine,
  DragRippleOverlay,
  rippleItemProps,
  rippleListProps,
  useDragRipple,
  type DragRipple,
} from "#src/components/ui/drag-ripple/drag-ripple";
import { useActiveTabInView } from "#src/hooks/use-active-tab-in-view";
import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export type ReorderableTabMeta = { label: () => string; icon?: FC<{ className?: string }> };

const MOUSE_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };
const TOUCH_SENSOR_OPTIONS = { activationConstraint: { delay: 250, tolerance: 5 } };

export function ReorderableTabStrip<T extends string>({
  tabs,
  meta,
  active,
  onSelect,
  onReorder,
  size = "sm",
  className,
  scrollRef,
  "aria-label": ariaLabel,
}: {
  tabs: readonly T[];
  meta: Record<T, ReorderableTabMeta>;
  active: T;
  onSelect: (tab: T) => void;
  onReorder: (order: T[]) => void;
  size?: "sm" | "md";
  className?: string;
  scrollRef?: RefObject<HTMLElement | null>;
  "aria-label": string;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
  );
  const dragged = useRef(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  useActiveTabInView(tabsRef, scrollRef ?? tabsRef);

  const [moving, setMoving] = useState<{ tab: T; order: T[] } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const instructions = useId();
  const elements = useRef(new Map<string, HTMLElement>());
  const setElement = useCallback((tab: string, node: HTMLElement | null) => {
    if (node) elements.current.set(tab, node);
    else elements.current.delete(tab);
  }, []);
  const shown = moving?.order ?? tabs;
  const at = (order: readonly T[], tab: T) => ({
    tab: meta[tab].label(),
    position: order.indexOf(tab) + 1,
    count: order.length,
  });

  const refocus = useRef<T | null>(null);
  useLayoutEffect(() => {
    if (refocus.current === null) return;
    elements.current.get(refocus.current)?.focus();
    refocus.current = null;
  });
  const tabSet = tabs.join(" ");
  useEffect(() => setMoving(null), [tabSet]);
  const { direction } = useLocale();
  useEffect(() => {
    if (!moving) return;
    const cancel = () => setMoving(null);
    document.addEventListener("pointerdown", cancel, true);
    return () => document.removeEventListener("pointerdown", cancel, true);
  }, [moving]);

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    const tab = [...elements.current].find(([, node]) => node === event.target)?.[0] as
      | T
      | undefined;
    if (!tab || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!moving) {
      if (event.key !== " ") return;
      setMoving({ tab, order: [...tabs] });
      setAnnouncement(m.tab_reorder_picked(at(tabs, tab)));
    } else {
      const from = moving.order.indexOf(moving.tab);
      const last = moving.order.length - 1;
      const step = direction === "rtl" ? -1 : 1;
      let to: number | undefined;
      switch (event.key) {
        case "ArrowLeft":
          to = from - step;
          break;
        case "ArrowRight":
          to = from + step;
          break;
        case "Home":
          to = 0;
          break;
        case "End":
          to = last;
      }
      if (to !== undefined) {
        const order = arrayMove([...moving.order], from, Math.min(Math.max(to, 0), last));
        setMoving({ tab: moving.tab, order });
        setAnnouncement(m.tab_reorder_moved(at(order, moving.tab)));
      } else if (event.key === " " || event.key === "Enter") {
        setMoving(null);
        if (moving.order.some((item, index) => item !== tabs[index])) onReorder(moving.order);
        setAnnouncement(m.tab_reorder_dropped(at(moving.order, moving.tab)));
      } else if (event.key === "Escape" || event.key === "Tab") {
        setMoving(null);
        setAnnouncement(m.tab_reorder_cancelled(at(tabs, moving.tab)));
        if (event.key === "Tab") return;
      } else return;
    }
    refocus.current = moving?.tab ?? tab;
    event.preventDefault();
    event.stopPropagation();
  };

  const ripple = useDragRipple({ axis: "x", amplitude: 10, signature: tabSet });
  const [lifted, setLifted] = useState<T | null>(null);
  useDocumentDragCursor(lifted !== null);
  const follow = ({ active: item }: DragMoveEvent) =>
    ripple.move(item.rect.current.translated, [STRIP]);
  const dropped = () => {
    const placed = ripple.end(true);
    const from = lifted ? tabs.indexOf(lifted) : -1;
    setLifted(null);
    if (placed && from >= 0 && placed.gap !== from)
      onReorder(arrayMove([...tabs], from, placed.gap));
  };
  const LiftedIcon = lifted ? meta[lifted].icon : undefined;
  const stripList = rippleListProps(ripple, STRIP);

  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements: SILENT_ANNOUNCEMENTS }}
      onDragStart={({ active: item }) => {
        dragged.current = true;
        setLifted(item.id as T);
        ripple.begin(STRIP, String(item.id));
      }}
      onDragMove={follow}
      onDragEnd={dropped}
      onDragCancel={() => {
        ripple.end(false);
        setLifted(null);
      }}
    >
      <div className="contents" onKeyDownCapture={keyDown}>
        <Tabs
          {...stripList}
          ref={(node: HTMLDivElement | null) => {
            tabsRef.current = node;
            stripList.ref(node);
          }}
          selectedKey={active}
          className={cx("relative w-max shrink-0", className)}
        >
          <TabList type="underline" size={size} aria-label={ariaLabel}>
            {shown.map((tab) => (
              <DraggableTab
                key={tab}
                id={tab}
                ripple={ripple}
                meta={meta[tab]}
                moving={moving?.tab === tab}
                describedBy={instructions}
                setElement={setElement}
                onPressStart={() => (dragged.current = false)}
                onPress={() => {
                  if (!dragged.current) onSelect(tab);
                }}
              />
            ))}
          </TabList>
          <DragRippleLine ripple={ripple} list={STRIP} className="text-primary" />
        </Tabs>
      </div>
      <span id={instructions} hidden>
        {m.tab_reorder_instructions()}
      </span>
      <span className="sr-only" aria-live="assertive">
        {announcement}
      </span>
      <DragRippleOverlay ripple={ripple}>
        {lifted ? (
          <div
            aria-hidden="true"
            style={ripple.liftStyle}
            className="flex h-full w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-semibold text-secondary shadow-lg ring-1 ring-secondary"
          >
            {LiftedIcon && <LiftedIcon className="size-4 shrink-0" />}
            {meta[lifted].label()}
          </div>
        ) : null}
      </DragRippleOverlay>
    </DndContext>
  );
}

const STRIP = "strip";

const SILENT_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

function DraggableTab({
  id,
  ripple,
  meta,
  moving,
  describedBy,
  setElement,
  onPressStart,
  onPress,
}: {
  id: string;
  ripple: DragRipple;
  meta: ReorderableTabMeta;
  moving: boolean;
  describedBy: string;
  setElement: (id: string, node: HTMLElement | null) => void;
  onPressStart: () => void;
  onPress: () => void;
}) {
  const { listeners, setNodeRef } = useDraggable({ id });
  const labelRef = useCallback(
    (label: HTMLSpanElement | null) => {
      const tab = label?.closest<HTMLElement>('[role="tab"]') ?? null;
      setNodeRef(tab);
      setElement(id, tab);
    },
    [setNodeRef, setElement, id],
  );
  return (
    <Tab
      {...rippleItemProps(ripple, STRIP, id)}
      id={id}
      icon={meta.icon}
      onMouseDownCapture={(event) => listeners?.onMouseDown?.(event)}
      onTouchStartCapture={(event) => listeners?.onTouchStart?.(event)}
      aria-describedby={describedBy}
      onPressStart={onPressStart}
      onPress={onPress}
      data-moving={moving || undefined}
      className="shrink-0 select-none [-webkit-touch-callout:none] border-transparent text-brand-secondary opacity-60 *:data-icon:text-fg-brand-secondary_hover hover:not-aria-selected:opacity-80 aria-selected:opacity-100 data-moving:rounded-md data-moving:bg-primary_hover"
    >
      <span ref={labelRef}>{meta.label()}</span>
    </Tab>
  );
}
