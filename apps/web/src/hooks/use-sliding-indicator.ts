import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { CONTINUOUS_EASING } from "#src/lib/shared-element-rect";

type IndicatorBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type IndicatorOptions = {
  activeKey: string | number | null | undefined;
  selector?: string;
  paused?: boolean;
  variant?: "underline" | "pill";
};

const DEFAULT_SELECTOR =
  '[aria-selected="true"], [aria-pressed="true"], [aria-current="page"], [data-selected="true"]';

function measureRelative(container: HTMLElement, selector: string): IndicatorBox | null {
  const active = container.querySelector<HTMLElement>(selector);
  if (!active) return null;
  const host = container.getBoundingClientRect();
  const box = active.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return {
    left: box.left - host.left + container.scrollLeft,
    top: box.top - host.top + container.scrollTop,
    width: box.width,
    height: box.height,
  };
}

export function computeStretchKeyframes(
  from: IndicatorBox,
  to: IndicatorBox,
  variant: "underline" | "pill",
): Keyframe[] {
  const sx = Math.max(0.1, from.width / to.width);
  const sy = Math.max(0.1, from.height / to.height);
  const movingRight = to.left >= from.left;
  const spanLeft = movingRight ? from.left + (to.left - from.left) * 0.22 : to.left;
  const spanRight = movingRight
    ? to.left + to.width
    : from.left + from.width - (from.left - to.left) * 0.22;
  const stretchedWidth = Math.max(to.width, spanRight - spanLeft);
  const stretchSx = Math.min(2.2, stretchedWidth / to.width);
  const midSquashY = variant === "pill" ? 0.86 : 1;
  const fromY = variant === "pill" ? from.top : 0;
  const toY = variant === "pill" ? to.top : 0;
  const midTop = variant === "pill" ? to.top + (to.height * (1 - midSquashY)) / 2 : 0;
  return [
    {
      transform: `translate3d(${from.left}px, ${fromY}px, 0) scale(${sx}, ${variant === "pill" ? sy : 1})`,
      offset: 0,
    },
    {
      transform: `translate3d(${spanLeft}px, ${midTop}px, 0) scale(${stretchSx}, ${midSquashY})`,
      offset: 0.36,
    },
    {
      transform: `translate3d(${to.left}px, ${toY}px, 0) scale(1, 1)`,
      offset: 1,
    },
  ];
}

export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement | null>,
  {
    activeKey,
    selector = DEFAULT_SELECTOR,
    paused = false,
    variant = "underline",
  }: IndicatorOptions,
): {
  indicatorRef: RefObject<HTMLSpanElement | null>;
  style: CSSProperties | undefined;
  visible: boolean;
} {
  const reduced = usePrefersReducedMotion();
  const desktop = useBreakpoint("lg");
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const prevBoxRef = useRef<IndicatorBox | null>(null);
  const prevKeyRef = useRef<string | number | null | undefined>(activeKey);
  const animRef = useRef<Animation | null>(null);
  const [box, setBox] = useState<IndicatorBox | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || paused) return;

    const sync = (animateMove: boolean) => {
      const next = measureRelative(container, selector);
      setBox(next);
      if (!next) {
        prevBoxRef.current = null;
        return;
      }
      const indicator = indicatorRef.current;
      let start = prevBoxRef.current;
      if (animateMove && indicator && animRef.current) {
        const host = container.getBoundingClientRect();
        const live = indicator.getBoundingClientRect();
        if (live.width > 0 && live.height > 0) {
          start = {
            left: live.left - host.left + container.scrollLeft,
            top: live.top - host.top + container.scrollTop,
            width: live.width,
            height: live.height,
          };
        }
        animRef.current.cancel();
        animRef.current = null;
      }
      prevBoxRef.current = next;
      if (
        !animateMove ||
        reduced ||
        !indicator ||
        !start ||
        typeof indicator.animate !== "function"
      )
        return;
      if (Math.abs(start.left - next.left) < 0.5 && Math.abs(start.width - next.width) < 0.5)
        return;
      const anim = indicator.animate(computeStretchKeyframes(start, next, variant), {
        duration: desktop ? 260 : 400,
        easing: CONTINUOUS_EASING,
      });
      animRef.current = anim;
      anim.addEventListener("finish", () => {
        if (animRef.current === anim) animRef.current = null;
      });
      anim.addEventListener("cancel", () => {
        if (animRef.current === anim) animRef.current = null;
      });
    };

    const keyChanged = prevKeyRef.current !== activeKey;
    prevKeyRef.current = activeKey;
    sync(keyChanged);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => sync(false));
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeKey, containerRef, desktop, paused, reduced, selector, variant]);

  const style: CSSProperties | undefined = box
    ? {
        width: `${box.width}px`,
        height: variant === "pill" ? `${box.height}px` : undefined,
        transform:
          variant === "pill"
            ? `translate3d(${box.left}px, ${box.top}px, 0)`
            : `translate3d(${box.left}px, 0, 0)`,
        transformOrigin: "top left",
      }
    : undefined;

  return { indicatorRef, style, visible: Boolean(box) && !paused };
}
