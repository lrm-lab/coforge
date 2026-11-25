import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "#src/utils/cx";

const SINGLE_ROW_MIN_HEADER_PX = 512;
const SINGLE_ROW_MIN_IDENTITY_PX = 120;
const SINGLE_ROW_COLUMN_GAP_PX = 20;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function shouldStackTabbedHeader({
  headerWidth,
  contentWidth,
  tabsWidth,
  actionsWidth,
  hasActions,
}: {
  headerWidth: number;
  contentWidth: number;
  tabsWidth: number;
  actionsWidth: number;
  hasActions: boolean;
}) {
  if (headerWidth <= 0) return false;
  if (headerWidth < SINGLE_ROW_MIN_HEADER_PX) return true;
  if (contentWidth <= 0 || tabsWidth <= 0) return false;
  const gaps = hasActions ? SINGLE_ROW_COLUMN_GAP_PX * 2 : SINGLE_ROW_COLUMN_GAP_PX;
  const required = SINGLE_ROW_MIN_IDENTITY_PX + tabsWidth + actionsWidth + gaps;
  return contentWidth < required;
}

type HeaderLayoutMode = "auto" | "single" | "stacked";

export function TabbedHeader({
  identity,
  actions,
  tabs,
  tabsStart,
  className,
}: {
  identity: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  tabsStart?: boolean;
  className?: string;
}) {
  const headerRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const tabsMeasureRef = useRef<HTMLDivElement>(null);
  const [layoutMode, setLayoutMode] = useState<HeaderLayoutMode>("auto");
  const [tabsOverflow, setTabsOverflow] = useState(false);

  const hasTabs = Boolean(tabs);
  const hasActions = Boolean(actions);

  useIsomorphicLayoutEffect(() => {
    if (!hasTabs) {
      setLayoutMode("auto");
      setTabsOverflow(false);
      return;
    }
    const header = headerRef.current;
    const tabsMeasure = tabsMeasureRef.current;
    if (!header || !tabsMeasure) return;

    const measure = () => {
      const tabsScroll = tabsScrollRef.current;
      const nextOverflow = tabsScroll ? tabsScroll.scrollWidth > tabsScroll.clientWidth + 1 : false;
      setTabsOverflow((prev) => (prev === nextOverflow ? prev : nextOverflow));
      const headerWidth = header.clientWidth;
      if (headerWidth <= 0) return;
      if (headerWidth < SINGLE_ROW_MIN_HEADER_PX) {
        setLayoutMode((prev) => (prev === "stacked" ? prev : "stacked"));
        return;
      }
      const style = getComputedStyle(header);
      const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const contentWidth = headerWidth - paddingX;
      const tabsWidth = Math.ceil(tabsMeasure.getBoundingClientRect().width);
      if (contentWidth <= 0 || tabsWidth <= 0) return;
      const actionsWidth = actionsRef.current
        ? Math.ceil(actionsRef.current.getBoundingClientRect().width)
        : 0;
      const next: HeaderLayoutMode = shouldStackTabbedHeader({
        headerWidth,
        contentWidth,
        tabsWidth,
        actionsWidth,
        hasActions,
      })
        ? "stacked"
        : "single";
      setLayoutMode((prev) => (prev === next ? prev : next));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(tabsMeasure);
    if (tabsScrollRef.current) observer.observe(tabsScrollRef.current);
    if (actionsRef.current) observer.observe(actionsRef.current);
    return () => observer.disconnect();
  }, [hasTabs, hasActions]);

  const singleRow = layoutMode === "single";
  const stacked = layoutMode === "stacked";

  return (
    <div className="@container/tabbed-header shrink-0">
      <header
        ref={headerRef}
        data-header-layout={layoutMode}
        className={cx(
          "relative grid border-b border-secondary px-4 md:px-6",
          singleRow && [
            "gap-x-5",
            tabsStart
              ? "grid-cols-[auto_minmax(0,1fr)_auto]"
              : "grid-cols-[minmax(0,auto)_max-content_minmax(max-content,1fr)]",
          ],
          stacked && [
            "grid-cols-[minmax(0,1fr)_auto]",
            hasTabs &&
              "before:pointer-events-none before:absolute before:inset-x-0 before:top-[calc(--spacing(12)-1px)] before:border-t before:border-secondary",
          ],
          layoutMode === "auto" && [
            "grid-cols-[minmax(0,1fr)_auto] @lg/tabbed-header:gap-x-5",
            hasTabs &&
              "before:pointer-events-none before:absolute before:inset-x-0 before:top-[calc(--spacing(12)-1px)] before:border-t before:border-secondary @lg/tabbed-header:before:hidden",
            tabsStart
              ? "@lg/tabbed-header:grid-cols-[auto_minmax(0,1fr)_auto]"
              : "@lg/tabbed-header:grid-cols-[minmax(0,auto)_max-content_minmax(max-content,1fr)]",
          ],
          className,
        )}
      >
        <div className="col-start-1 row-start-1 flex h-[calc(--spacing(12)-1px)] min-w-0 items-center gap-2 md:gap-3">
          {identity}
        </div>
        {actions && (
          <div
            ref={actionsRef}
            className={cx(
              "row-start-1 flex items-center justify-self-end",
              singleRow && "col-start-3",
              stacked && "col-start-2",
              layoutMode === "auto" && "col-start-2 @lg/tabbed-header:col-start-3",
            )}
          >
            {actions}
          </div>
        )}
        {tabs && (
          <div
            ref={tabsScrollRef}
            className={cx(
              "flex min-w-0 max-w-full",
              !tabsOverflow && "[touch-action:pan-y_pinch-zoom]",
              singleRow && [
                "col-span-1 col-start-2 row-start-1",
                tabsStart ? "items-center py-0" : "-mb-px items-end pt-0",
              ],
              stacked && [
                "col-span-2 row-start-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                tabsStart ? "items-center py-2" : "-mb-px items-end pt-2",
              ],
              layoutMode === "auto" && [
                "col-span-2 row-start-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden @lg/tabbed-header:col-span-1 @lg/tabbed-header:col-start-2 @lg/tabbed-header:row-start-1",
                tabsStart
                  ? "items-center py-2 @lg/tabbed-header:py-0"
                  : "-mb-px items-end pt-2 @lg/tabbed-header:pt-0",
              ],
            )}
          >
            <div ref={tabsMeasureRef} className="min-h-8 w-max shrink-0">
              {tabs}
            </div>
          </div>
        )}
      </header>
    </div>
  );
}
