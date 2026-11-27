import { useRef, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";

import { CountBadge } from "#src/components/ui/unread-marker";
import { useActiveTabInView } from "#src/hooks/use-active-tab-in-view";
import { edgeFadeStyle, useScrollEdges } from "#src/hooks/use-scroll-edges";
import { useSlidingIndicator } from "#src/hooks/use-sliding-indicator";
import { cx } from "#src/utils/cx";

export const UNDERLINE_STRIP_SCROLL_CLASS =
  "-mb-px flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export const UNDERLINE_TAB_CLASS =
  "relative z-10 h-9 shrink-0 select-none gap-1.5 rounded-none border-b-0 px-0.5 py-0 text-sm font-medium text-tertiary transition-colors duration-100 ease-out outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 any-pointer-coarse:h-11 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b-2 after:border-transparent";

export type UnderlineFilterItem<T extends string> = {
  id: T;
  label: string;
  count?: number | null | undefined;
};

export function UnderlineStripFrame({
  activeKey,
  scrollKey,
  observe,
  className,
  children,
}: {
  activeKey: string;
  scrollKey?: string;
  observe: string;
  className?: string;
  children: (slidingVisible: boolean) => ReactNode;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const fade = useScrollEdges("x", { observe, key: scrollKey });
  useActiveTabInView(groupRef, fade.ref);
  const indicator = useSlidingIndicator(groupRef, { activeKey, variant: "underline" });

  return (
    <div
      ref={fade.ref}
      style={edgeFadeStyle(fade, { start: "1.25rem", end: "1.5rem" })}
      className={cx(UNDERLINE_STRIP_SCROLL_CLASS, className)}
    >
      <div ref={groupRef} className="relative w-max shrink-0">
        {children(indicator.visible)}
        {indicator.visible && (
          <span
            ref={indicator.indicatorRef}
            aria-hidden="true"
            style={indicator.style}
            className="pointer-events-none absolute bottom-0 left-0 z-20 border-b-2 border-fg-primary"
          />
        )}
      </div>
    </div>
  );
}

export function UnderlineFilterGroup<T extends string>({
  "aria-label": ariaLabel,
  items,
  value,
  onChange,
  onItemIntent,
  className,
  listClassName,
}: {
  "aria-label": string;
  items: ReadonlyArray<UnderlineFilterItem<T>>;
  value: T;
  onChange: (next: T) => void;
  onItemIntent?: (id: T) => void;
  className?: string;
  listClassName?: string;
}) {
  const keySignature = items.map((item) => `${item.id}:${item.count ?? ""}`).join("|");
  const activeKey = `${value}:${keySignature}`;

  return (
    <UnderlineStripFrame
      activeKey={activeKey}
      scrollKey={keySignature}
      observe="button"
      className={className}
    >
      {(slidingVisible) => (
        <div
          role="group"
          aria-label={ariaLabel}
          className={cx("flex w-max shrink-0 items-center gap-4", listClassName)}
        >
          {items.map((item) => {
            const active = item.id === value;
            return (
              <AriaButton
                key={item.id}
                aria-pressed={active}
                onPress={() => {
                  if (!active) onChange(item.id);
                }}
                onHoverStart={() => onItemIntent?.(item.id)}
                onFocus={() => onItemIntent?.(item.id)}
                className={cx(
                  UNDERLINE_TAB_CLASS,
                  "inline-flex cursor-pointer items-center justify-center px-1 whitespace-nowrap aria-pressed:text-primary",
                  !slidingVisible && "aria-pressed:after:border-fg-primary",
                )}
              >
                <span>{item.label}</span>
                {item.count !== undefined && <CountBadge count={item.count} size="sm" />}
              </AriaButton>
            );
          })}
        </div>
      )}
    </UnderlineStripFrame>
  );
}
