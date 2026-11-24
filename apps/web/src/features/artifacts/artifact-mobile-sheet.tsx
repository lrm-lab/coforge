import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { animate, useMotionValue, useTransform } from "motion/react";
import * as motion from "motion/react-m";
import { FocusScope } from "react-aria";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { acquirePageFlowHandoff, isTopPageFlowEntry } from "#src/lib/page-flow-handoff";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { DURATION_S, EASE_OUT } from "#src/utils/motion-tokens";

type SheetSnap = "half" | "tall";

const HALF_DELTA_RATIO = 0.27;
const DRAG_THRESHOLD_PX = 6;
const DISMISS_OFFSET_PX = 96;
const DISMISS_VELOCITY_PX = 500;
const COLLAPSE_FROM_TALL_OFFSET_PX = 240;
const COLLAPSE_FROM_TALL_VELOCITY_PX = 900;
const EXPAND_OFFSET_PX = -60;
const EXPAND_VELOCITY_PX = -400;
const UPWARD_ELASTICITY = 0.2;

function viewportHeight(): number {
  return typeof window === "undefined" ? 800 : window.innerHeight;
}

function snapOffsetPx(snap: SheetSnap): number {
  return snap === "tall" ? 0 : Math.round(viewportHeight() * HALF_DELTA_RATIO);
}

function findScrollableDescendant(container: HTMLElement | null): HTMLElement | null {
  if (!container) return null;
  const marked = container.querySelector<HTMLElement>(
    "[data-artifact-scroll], [class*='overflow-y-auto'], [class*='overflow-y-scroll']",
  );
  if (marked && marked.scrollHeight > marked.clientHeight) return marked;
  return null;
}

export function ArtifactMobileSheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const wide = useBreakpoint("sm");
  const [snap, setSnap] = useState<SheetSnap>("half");
  const snapRef = useRef<SheetSnap>("half");
  snapRef.current = snap;
  const sheetRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const entryIdRef = useRef<symbol | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const handedScrollRef = useRef(0);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const [scrimBox, setScrimBox] = useState<{ top: number; height: number }>({ top: 0, height: 0 });
  const y = useMotionValue(reduced ? snapOffsetPx("half") : viewportHeight());
  const backdropOpacity = useTransform(y, (current) => {
    const halfOffset = snapOffsetPx("half");
    if (current <= halfOffset) return 1;
    return Math.max(0, 1 - (current - halfOffset) / 320);
  });

  const isTallFlow = snap === "tall" && !wide;

  const animateToSnap = useCallback(
    (nextSnap: SheetSnap, velocity = 0) => {
      const target = snapOffsetPx(nextSnap);
      if (reduced) {
        animate(y, target, { duration: DURATION_S.reduced, ease: EASE_OUT });
      } else {
        animate(y, target, { type: "spring", duration: 0.38, bounce: 0, velocity });
      }
    },
    [reduced, y],
  );

  useEffect(() => {
    if (!isTallFlow) animateToSnap(snapRef.current);
  }, [animateToSnap, isTallFlow]);

  useLayoutEffect(() => {
    if (isTallFlow || typeof window === "undefined") return;
    const sync = () => {
      const top = Math.max(0, window.scrollY);
      const docHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        window.innerHeight,
      );
      const height = Math.max(
        window.innerHeight,
        Math.min(docHeight - top, window.innerHeight * 1.25),
      );
      setScrimBox({ top, height });
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, { passive: true });
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync);
    };
  }, [isTallFlow]);

  useLayoutEffect(() => {
    if (!isTallFlow || typeof window === "undefined") return;
    const handoff = acquirePageFlowHandoff({
      root: document.getElementById("coforge-app-root"),
      win: window,
      layerEl: sheetRef.current,
      initialScrollTop: handedScrollRef.current,
    });
    entryIdRef.current = handoff.id;
    return () => {
      entryIdRef.current = null;
      handoff.release((pageScrollY) => {
        handedScrollRef.current = pageScrollY;
      });
    };
  }, [isTallFlow]);

  useLayoutEffect(() => {
    if (isTallFlow || handedScrollRef.current <= 0) return;
    const scroller = findScrollableDescendant(bodyRef.current);
    if (scroller) {
      scroller.scrollTop = handedScrollRef.current;
    }
    handedScrollRef.current = 0;
  }, [isTallFlow]);

  useEffect(() => {
    if (wide) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (entryIdRef.current && !isTopPageFlowEntry(entryIdRef.current)) return;
      if (document.querySelector("[data-page-scrim]")) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [wide]);

  useEffect(() => {
    const onResize = () => {
      if (!isTallFlow) y.set(snapOffsetPx(snapRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cleanupDragRef.current?.();
    };
  }, [y, isTallFlow]);

  const commitSnap = (nextSnap: SheetSnap, velocity = 0) => {
    if (nextSnap === "tall" && snapRef.current === "half") {
      const scroller = findScrollableDescendant(bodyRef.current);
      handedScrollRef.current = scroller?.scrollTop ?? 0;
    }
    snapRef.current = nextSnap;
    setSnap(nextSnap);
    if (nextSnap === "half") {
      animateToSnap(nextSnap, velocity);
    }
  };

  const toggleSnap = () => {
    commitSnap(snapRef.current === "half" ? "tall" : "half");
  };

  const onHandlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    cleanupDragRef.current?.();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const baseY = isTallFlow ? 0 : y.get();
    let lastY = startY;
    let lastTime = performance.now();
    let velocity = 0;
    let offsetY = 0;
    let moved = false;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const now = performance.now();
      const dt = now - lastTime;
      offsetY = moveEvent.clientY - startY;
      if (Math.abs(offsetY) > DRAG_THRESHOLD_PX) moved = true;
      if (dt > 0) velocity = ((moveEvent.clientY - lastY) / dt) * 1000;
      lastY = moveEvent.clientY;
      lastTime = now;
      if (!isTallFlow) {
        const next = baseY + offsetY;
        y.set(next < 0 ? next * UPWARD_ELASTICITY : next);
      }
    };

    const cleanup = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onFinish);
      target.removeEventListener("pointercancel", onCancel);
      cleanupDragRef.current = null;
    };

    const onCancel = () => {
      cleanup();
      if (!isTallFlow) animateToSnap(snapRef.current, 0);
    };

    const onFinish = () => {
      cleanup();
      if (!moved) {
        toggleSnap();
        return;
      }
      const draggedDown = offsetY > DISMISS_OFFSET_PX || velocity > DISMISS_VELOCITY_PX;
      const draggedUp = offsetY < EXPAND_OFFSET_PX || velocity < EXPAND_VELOCITY_PX;
      if (draggedDown) {
        if (
          snapRef.current === "tall" &&
          offsetY < COLLAPSE_FROM_TALL_OFFSET_PX &&
          velocity < COLLAPSE_FROM_TALL_VELOCITY_PX
        ) {
          commitSnap("half", velocity);
          return;
        }
        onClose();
        return;
      }
      if (draggedUp && snapRef.current === "half") {
        commitSnap("tall", velocity);
        return;
      }
      if (!isTallFlow) animateToSnap(snapRef.current, velocity);
    };

    cleanupDragRef.current = cleanup;
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onFinish);
    target.addEventListener("pointercancel", onCancel);
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSnap();
    }
  };

  if (wide || typeof document === "undefined") return null;

  return createPortal(
    <>
      {!isTallFlow && (
        <motion.div
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced ? DURATION_S.reduced : DURATION_S.sm, ease: EASE_OUT }}
          style={{
            opacity: backdropOpacity,
            top: `${scrimBox.top}px`,
            height: scrimBox.height > 0 ? `${scrimBox.height}px` : "100dvh",
          }}
          onClick={onClose}
          className="absolute inset-x-0 z-40 bg-overlay/50 sm:hidden"
        />
      )}
      <FocusScope contain restoreFocus autoFocus>
        <motion.aside
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          data-artifact-mobile-sheet=""
          data-phone-page-flow={isTallFlow ? "" : undefined}
          initial={reduced ? { opacity: 0 } : undefined}
          animate={reduced ? { opacity: 1 } : undefined}
          transition={reduced ? { duration: DURATION_S.reduced, ease: EASE_OUT } : undefined}
          style={isTallFlow ? undefined : { y }}
          className={cn(
            "z-50 flex flex-col bg-primary sm:hidden",
            isTallFlow
              ? "relative min-h-dvh w-full pt-safe-top pb-safe-bottom"
              : "fixed inset-x-0 bottom-0 h-[92dvh] overflow-hidden rounded-t-2xl border-t border-secondary pb-[calc(27dvh+var(--spacing-safe-bottom))] shadow-xl will-change-transform",
          )}
        >
          <div
            role="button"
            tabIndex={0}
            aria-label={m.av_sheet_drag_label()}
            aria-expanded={isTallFlow}
            onPointerDown={onHandlePointerDown}
            onKeyDown={onHandleKeyDown}
            className={cn(
              "flex min-h-11 w-full shrink-0 cursor-grab touch-none items-center justify-center bg-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2 active:cursor-grabbing",
              isTallFlow && "sticky top-0 z-10",
            )}
          >
            <span aria-hidden="true" className="h-1 w-9 rounded-full bg-quaternary" />
          </div>
          <div ref={bodyRef} className={cn("flex flex-1 flex-col", !isTallFlow && "min-h-0")}>
            {children}
          </div>
        </motion.aside>
      </FocusScope>
    </>,
    document.body,
  );
}
