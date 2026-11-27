import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
        className={cx(
          "relative grid grid-cols-[minmax(0,1fr)_auto] border-b border-secondary px-4 md:px-6",
          hasTabs &&
            "before:pointer-events-none before:absolute before:inset-x-0 before:top-[calc(--spacing(12)-1px)] before:border-t before:border-secondary",
          className,
        )}
      >
        <div className="col-start-1 row-start-1 flex h-[calc(--spacing(12)-1px)] min-w-0 items-center gap-2 md:gap-3">
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
            className={cx(
              "col-span-2 row-start-2 -mx-2 -mb-px flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              !tabsOverflow && "[touch-action:pan-y_pinch-zoom]",
            )}
          >
            <div className="flex min-h-9 w-max shrink-0 items-center any-pointer-coarse:min-h-11">
              {tabs}
            </div>
          </div>
        )}
      </header>
    </div>
  );
}
