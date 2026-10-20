import { useCallback, useRef, type FC, type RefObject } from "react";
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

import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import { useActiveTabInView } from "#src/hooks/use-active-tab-in-view";
import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
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
      <SortableContext items={[...tabs]} strategy={horizontalListSortingStrategy}>
        {/* Selection stays with the caller: a mouse press would otherwise select on press start,
         * before a drag can begin, so each tab selects from its own `onPress` instead. */}
        <Tabs ref={tabsRef} selectedKey={active} className={cx("w-max shrink-0", className)}>
          <TabList type="underline" size={size} aria-label={ariaLabel}>
            {tabs.map((tab) => (
              <SortableTab
                key={tab}
                id={tab}
                meta={meta[tab]}
                onPressStart={() => (dragged.current = false)}
                onPress={() => {
                  if (!dragged.current) onSelect(tab);
                }}
              />
            ))}
          </TabList>
        </Tabs>
      </SortableContext>
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
  onPressStart,
  onPress,
}: {
  id: string;
  meta: ReorderableTabMeta;
  onPressStart: () => void;
  onPress: () => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  useDocumentDragCursor(isDragging);
  // The official Tab takes no ref, so the sortable node is the tab element around its label.
  const labelRef = useCallback(
    (label: HTMLSpanElement | null) =>
      setNodeRef(label?.closest<HTMLElement>('[role="tab"]') ?? null),
    [setNodeRef],
  );
  return (
    <Tab
      id={id}
      icon={meta.icon}
      // The tab handles its own press events and stops them from bubbling, so the sensors
      // listen in the capture phase instead.
      onMouseDownCapture={(event) => listeners?.onMouseDown?.(event)}
      onTouchStartCapture={(event) => listeners?.onTouchStart?.(event)}
      onPressStart={onPressStart}
      onPress={onPress}
      data-dragging={isDragging || undefined}
      className="shrink-0 select-none [-webkit-touch-callout:none] data-dragging:z-20 data-dragging:transition-none"
      style={{
        transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
        transition,
      }}
    >
      <span ref={labelRef}>{meta.label()}</span>
    </Tab>
  );
}
