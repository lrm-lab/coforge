import { useEffect, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import {
  Group,
  Panel,
  Separator,
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
  type PanelSize,
} from "react-resizable-panels";
import { cn } from "#src/lib/utils";
import {
  applyListWidthProperty,
  readStoredListWidth,
  rootFontSizePx,
  writeStoredListWidth,
  type ListColumn,
} from "./conversation-list-width";

const COLUMN_RESIZE_TARGET = { coarse: 44, fine: 12 };
const HIDDEN_OVERFLOW_PANEL_STYLE = { overflow: "hidden" } as const;
const VISIBLE_OVERFLOW_PANEL_STYLE = { overflow: "visible" } as const;

function panelsTotalWidthPx(groupElement: HTMLDivElement | null): number {
  if (!groupElement) return 0;
  let total = 0;
  for (const child of groupElement.children) {
    if (child instanceof HTMLElement && child.hasAttribute("data-panel")) {
      total += child.offsetWidth;
    }
  }
  return total;
}

function useResizableColumn(
  column: ListColumn,
  { active, hidden = false, panelId }: { active: boolean; hidden?: boolean; panelId: string },
) {
  const groupElementRef = useRef<HTMLDivElement>(null);
  const panelRef = usePanelRef();

  useLayoutEffect(() => {
    if (!active || hidden) return;
    const panel = panelRef.current;
    if (!panel) return;
    const stored = readStoredListWidth(column);
    applyListWidthProperty(column, stored);
    panel.resize(`${stored}rem`);
  }, [active, hidden, column, panelRef]);

  useEffect(() => {
    if (!active) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== column.key) return;
      const stored = readStoredListWidth(column);
      applyListWidthProperty(column, stored);
      if (!hidden) panelRef.current?.resize(`${stored}rem`);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [active, hidden, column, panelRef]);

  const onResize = (size: PanelSize, _id: string | number | undefined, prev?: PanelSize) => {
    if (hidden || prev === undefined || size.inPixels <= 0) return;
    applyListWidthProperty(column, size.inPixels / rootFontSizePx());
  };

  const onLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction || hidden) return;
    const pct = layout[panelId];
    const groupPx = panelsTotalWidthPx(groupElementRef.current);
    const px =
      pct !== undefined && groupPx > 0
        ? (pct / 100) * groupPx
        : (panelRef.current?.getSize().inPixels ?? 0);
    if (px <= 0) return;
    writeStoredListWidth(column, px / rootFontSizePx());
  };

  const onDoubleClick = () => {
    writeStoredListWidth(column, column.defaultWidth);
  };

  return {
    groupElementRef,
    panelRef,
    onResize,
    onLayoutChanged,
    onDoubleClick,
    panelProps: hidden
      ? {
          defaultSize: 0 as const,
          minSize: 0 as const,
          maxSize: 0 as const,
        }
      : {
          defaultSize: `${column.defaultWidth}rem`,
          minSize: `${column.min}rem`,
          maxSize: `${column.max}rem`,
        },
    siblingMinSize: hidden ? "100%" : `${100 - column.maxPct}%`,
  };
}

function ColumnResizeSeparator({
  label,
  onDoubleClick,
  className,
  ...props
}: Omit<ComponentProps<typeof Separator>, "aria-label"> & {
  label: string;
}) {
  return (
    <Separator
      aria-label={label}
      onDoubleClick={onDoubleClick}
      className={cn(
        "relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-border-secondary outline-hidden after:pointer-events-none after:absolute after:inset-y-0 after:start-0 after:w-0.5 after:bg-transparent after:transition-colors hover:after:bg-brand-solid focus-visible:after:bg-brand-solid data-[separator=hover]:after:bg-brand-solid data-[separator=active]:after:bg-brand-solid",
        className,
      )}
      {...props}
    />
  );
}

export function ResizableColumnSplit({
  id,
  column,
  active,
  hidden = false,
  side = "start",
  columnContent,
  siblingContent,
  siblingOverflow = "visible",
}: {
  id: string;
  column: ListColumn;
  active: boolean;
  hidden?: boolean;
  side?: "start" | "end";
  columnContent: ReactNode;
  siblingContent: ReactNode;
  siblingOverflow?: "hidden" | "visible";
}) {
  const panelId = side === "start" ? "list" : "comments";
  const split = useResizableColumn(column, { active, hidden, panelId });
  if (!active) {
    return side === "start" ? (
      <>
        {columnContent}
        {siblingContent}
      </>
    ) : (
      <>
        {siblingContent}
        {columnContent}
      </>
    );
  }
  const resizablePanel = (
    <Panel
      id={panelId}
      panelRef={split.panelRef}
      {...split.panelProps}
      groupResizeBehavior="preserve-pixel-size"
      onResize={split.onResize}
      data-review-comments={side === "end" ? "" : undefined}
      style={HIDDEN_OVERFLOW_PANEL_STYLE}
      className="flex min-h-0 min-w-0 flex-col"
    >
      {columnContent}
    </Panel>
  );
  const siblingPanel = (
    <Panel
      id={side === "start" ? "detail" : "file"}
      minSize={split.siblingMinSize}
      groupResizeBehavior="preserve-relative-size"
      style={
        siblingOverflow === "hidden" ? HIDDEN_OVERFLOW_PANEL_STYLE : VISIBLE_OVERFLOW_PANEL_STYLE
      }
      className="flex min-h-0 min-w-0 flex-col"
    >
      {siblingContent}
    </Panel>
  );
  const separator = !hidden && (
    <ColumnResizeSeparator label={column.label()} onDoubleClick={split.onDoubleClick} />
  );
  return (
    <Group
      id={id}
      elementRef={split.groupElementRef}
      orientation="horizontal"
      onLayoutChanged={split.onLayoutChanged}
      resizeTargetMinimumSize={COLUMN_RESIZE_TARGET}
      className="flex min-h-0 min-w-0 flex-1"
    >
      {side === "start" ? (
        <>
          {resizablePanel}
          {separator}
          {siblingPanel}
        </>
      ) : (
        <>
          {siblingPanel}
          {separator}
          {resizablePanel}
        </>
      )}
    </Group>
  );
}
