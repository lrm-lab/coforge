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
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { useLocale } from "react-aria-components";

import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import { useActiveTabInView } from "#src/hooks/use-active-tab-in-view";
import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export type ReorderableTabMeta = { label: () => string; icon?: FC<{ className?: string }> };

export function ReorderableTabStrip<T extends string>({
  tabs,
  meta,
  active,
  onSelect,
  onReorder,
  size = "sm",
  quiet = false,
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
  quiet?: boolean;
  className?: string;
  scrollRef?: RefObject<HTMLElement | null>;
  "aria-label": string;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
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

  const dropped = ({ active: moved, over }: DragEndEvent) => {
    const from = tabs.indexOf(moved.id as T);
    const to = over ? tabs.indexOf(over.id as T) : -1;
    if (to >= 0 && from !== to) onReorder(arrayMove([...tabs], from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{ announcements: SILENT_ANNOUNCEMENTS }}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={dropped}
    >
      <SortableContext items={[...shown]} strategy={horizontalListSortingStrategy}>
        <div className="contents" onKeyDownCapture={keyDown}>
          <Tabs ref={tabsRef} selectedKey={active} className={cx("w-max shrink-0", className)}>
            <TabList
              type="underline"
              size={size}
              aria-label={ariaLabel}
              className={quiet ? "before:hidden" : undefined}
            >
              {shown.map((tab) => (
                <SortableTab
                  key={tab}
                  id={tab}
                  meta={meta[tab]}
                  moving={moving?.tab === tab}
                  quiet={quiet}
                  describedBy={instructions}
                  setElement={setElement}
                  onPressStart={() => (dragged.current = false)}
                  onPress={() => {
                    if (!dragged.current) onSelect(tab);
                  }}
                />
              ))}
            </TabList>
          </Tabs>
        </div>
      </SortableContext>
      <span id={instructions} hidden>
        {m.tab_reorder_instructions()}
      </span>
      <span className="sr-only" aria-live="assertive">
        {announcement}
      </span>
    </DndContext>
  );
}

const SILENT_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

function SortableTab({
  id,
  meta,
  moving,
  quiet,
  describedBy,
  setElement,
  onPressStart,
  onPress,
}: {
  id: string;
  meta: ReorderableTabMeta;
  moving: boolean;
  quiet: boolean;
  describedBy: string;
  setElement: (id: string, node: HTMLElement | null) => void;
  onPressStart: () => void;
  onPress: () => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  useDocumentDragCursor(isDragging);
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
      id={id}
      icon={meta.icon}
      onMouseDownCapture={(event) => listeners?.onMouseDown?.(event)}
      onTouchStartCapture={(event) => listeners?.onTouchStart?.(event)}
      aria-describedby={describedBy}
      onPressStart={onPressStart}
      onPress={onPress}
      data-dragging={isDragging || undefined}
      data-moving={moving || undefined}
      className={cx(
        "shrink-0 select-none [-webkit-touch-callout:none] data-dragging:z-20 data-dragging:transition-none data-moving:rounded-md data-moving:bg-primary_hover",
        quiet && "border-transparent opacity-60 hover:opacity-100 aria-selected:opacity-100",
      )}
      style={{
        transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
        transition,
      }}
    >
      <span ref={labelRef}>{meta.label()}</span>
    </Tab>
  );
}
