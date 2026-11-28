import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { PANE_HEADER_ATTR, PANE_SUBBAR_ATTR } from "#src/components/layout/pane-header";
import { cx } from "#src/utils/cx";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function TabbedHeader({
  identity,
  actions,
  tabs,
  className,
}: {
  identity: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  className?: string;
}) {
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);

  const hasTabs = Boolean(tabs);

  useIsomorphicLayoutEffect(() => {
    if (!hasTabs) {
      setTabsOverflow(false);
      return;
    }
    const tabsScroll = tabsScrollRef.current;
    if (!tabsScroll) return;

    const measure = () => {
      const nextOverflow = tabsScroll.scrollWidth > tabsScroll.clientWidth + 1;
      setTabsOverflow((prev) => (prev === nextOverflow ? prev : nextOverflow));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(tabsScroll);
    const content = tabsScroll.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [hasTabs]);

  return (
    <div className="shrink-0">
      <header
        {...PANE_HEADER_ATTR}
        className={cx(
          "relative grid grid-cols-[minmax(0,1fr)_auto] border-b border-secondary px-4 md:px-6",
          !hasTabs && "h-pane-header",
          hasTabs &&
            "before:pointer-events-none before:absolute before:inset-x-0 before:top-[calc(var(--pane-header-height)-1px)] before:border-t before:border-secondary",
          className,
        )}
      >
        <div
          className={cx(
            "col-start-1 row-start-1 flex min-w-0 items-center gap-2 md:gap-3",
            hasTabs ? "h-pane-header" : "h-full",
          )}
        >
          {identity}
        </div>
        {actions && (
          <div className="col-start-2 row-start-1 flex items-center justify-self-end">
            {actions}
          </div>
        )}
        {tabs && (
          <div
            ref={tabsScrollRef}
            {...PANE_SUBBAR_ATTR}
            className={cx(
              "col-span-2 row-start-2 -mx-2 -mb-px flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              !tabsOverflow && "[touch-action:pan-y_pinch-zoom]",
            )}
          >
            <div className="flex min-h-pane-subbar w-max shrink-0 items-center">{tabs}</div>
          </div>
        )}
      </header>
    </div>
  );
}
