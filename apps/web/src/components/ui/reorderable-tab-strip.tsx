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

/**
 * A panel's tab strip whose tabs the viewer drags into their own order. It is the official
 * horizontal `underline` Tabs list; dragging
 * only translates a tab along the strip
 * ([dnd-kit Sortable](https://docs.dndkit.com/presets/sortable)). A mouse drag starts after 6px
 * of movement so a click still selects; a touch drag starts after a 250ms press so a swipe still
 * scrolls a strip that overflows a phone
 * ([dnd-kit sensors](https://docs.dndkit.com/api-documentation/sensors)).
 *
 * The keyboard reorders too, as Raft's strips do: Space picks up the focused tab, the arrow keys
 * (and Home, End) move it, Space or Enter drops it and Escape puts it back. Each step is announced.
 * The strip handles these keys itself rather than through dnd-kit's keyboard sensor: that sensor
 * reads the arrows on the document, after the tab list has used them to move focus.
 */
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
  /** The tabs in display order. */
  tabs: readonly T[];
  meta: Record<T, ReorderableTabMeta>;
  active: T;
  onSelect: (tab: T) => void;
  onReorder: (order: T[]) => void;
  size?: "sm" | "md";
  className?: string;
  /** The caller's element that scrolls the strip sideways when its tabs do not fit; the selected
   * tab is kept in view inside it (`useActiveTabInView`). */
  scrollRef?: RefObject<HTMLElement | null>;
  "aria-label": string;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  // Releasing a dragged tab is also a press on it; that press is swallowed so a drop only
  // reorders. The flag is cleared when the next press starts.
  const dragged = useRef(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  // A strip with more tabs than room scrolls, so the selected tab can start out of sight.
  useActiveTabInView(tabsRef, scrollRef ?? tabsRef);

  // The tab picked up from the keyboard, and the order it is being moved through.
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

  // Moving a tab re-inserts its element, which loses focus; so does putting it back or dropping
  // it. Focus returns to it after each keyboard step.
  const refocus = useRef<T | null>(null);
  useLayoutEffect(() => {
    if (refocus.current === null) return;
    elements.current.get(refocus.current)?.focus();
    refocus.current = null;
  });
  // A tab appearing or going (permissions settling, say) ends a keyboard move without saving it.
  const tabSet = tabs.join(" ");
  useEffect(() => setMoving(null), [tabSet]);
  const { direction } = useLocale();
  // A press anywhere else puts a picked-up tab back.
  useEffect(() => {
    if (!moving) return;
    const cancel = () => setMoving(null);
    document.addEventListener("pointerdown", cancel, true);
    return () => document.removeEventListener("pointerdown", cancel, true);
  }, [moving]);

  // Keys reach this wrapper before the tab list sees them.
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
      // The arrows follow the reading direction.
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
        // Tab still moves focus on.
        if (event.key === "Tab") return;
      } else return;
    }
    refocus.current = moving?.tab ?? tab;
    // The tab list would otherwise select on Space and move focus on the arrows.
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
      // Tabs are reordered with a pointer only, so there is no keyboard drag to announce.
      accessibility={{ announcements: SILENT_ANNOUNCEMENTS }}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={dropped}
    >
      <SortableContext items={[...shown]} strategy={horizontalListSortingStrategy}>
        {/* Selection stays with the caller: a mouse press would otherwise select on press start,
         * before a drag can begin, so each tab selects from its own `onPress` instead. */}
        {/* Layout-free: it only sees the tabs' keys first. */}
        <div className="contents" onKeyDownCapture={keyDown}>
          <Tabs ref={tabsRef} selectedKey={active} className={cx("w-max shrink-0", className)}>
            <TabList type="underline" size={size} aria-label={ariaLabel}>
              {shown.map((tab) => (
                <SortableTab
                  key={tab}
                  id={tab}
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
  describedBy,
  setElement,
  onPressStart,
  onPress,
}: {
  id: string;
  meta: ReorderableTabMeta;
  /** Picked up from the keyboard. */
  moving: boolean;
  describedBy: string;
  setElement: (id: string, node: HTMLElement | null) => void;
  onPressStart: () => void;
  onPress: () => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  useDocumentDragCursor(isDragging);
  // The official Tab takes no ref, so the sortable node is the tab element around its label.
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
      // The tab handles its own press events and stops them from bubbling, so the sensors
      // listen in the capture phase instead.
      onMouseDownCapture={(event) => listeners?.onMouseDown?.(event)}
      onTouchStartCapture={(event) => listeners?.onTouchStart?.(event)}
      aria-describedby={describedBy}
      onPressStart={onPressStart}
      onPress={onPress}
      data-dragging={isDragging || undefined}
      data-moving={moving || undefined}
      className="shrink-0 select-none [-webkit-touch-callout:none] data-dragging:z-20 data-dragging:transition-none data-moving:rounded-md data-moving:bg-primary_hover"
      style={{
        transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
        transition,
      }}
    >
      <span ref={labelRef}>{meta.label()}</span>
    </Tab>
  );
}
