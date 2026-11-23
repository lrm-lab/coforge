import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { FocusScope } from "react-aria";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
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
  const [snap, setSnap] = useState<SheetSnap>("half");
  const snapRef = useRef<SheetSnap>("half");
  snapRef.current = snap;
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const y = useMotionValue(reduced ? snapOffsetPx("half") : viewportHeight());
  const backdropOpacity = useTransform(y, (current) => {
    const halfOffset = snapOffsetPx("half");
    if (current <= halfOffset) return 1;
    return Math.max(0, 1 - (current - halfOffset) / 320);
  });

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
    animateToSnap(snapRef.current);
  }, [animateToSnap]);

  useEffect(() => {
    const onResize = () => {
      y.set(snapOffsetPx(snapRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cleanupDragRef.current?.();
    };
  }, [y]);

  const commitSnap = (nextSnap: SheetSnap, velocity = 0) => {
    snapRef.current = nextSnap;
    setSnap(nextSnap);
    animateToSnap(nextSnap, velocity);
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
    const baseY = y.get();
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
      const next = baseY + offsetY;
      y.set(next < 0 ? next * UPWARD_ELASTICITY : next);
    };

    const cleanup = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onFinish);
      target.removeEventListener("pointercancel", onCancel);
      cleanupDragRef.current = null;
    };

    const onCancel = () => {
      cleanup();
      animateToSnap(snapRef.current, 0);
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
      animateToSnap(snapRef.current, velocity);
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

  return (
    <div className="fixed inset-0 z-40 sm:hidden">
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reduced ? DURATION_S.reduced : DURATION_S.sm, ease: EASE_OUT }}
        style={{ opacity: backdropOpacity }}
        onClick={onClose}
        className="fixed inset-0 bg-overlay/50"
      />
      <FocusScope contain restoreFocus autoFocus>
        <motion.aside
          role="dialog"
          aria-modal="true"
          aria-label={label}
          data-artifact-mobile-sheet=""
          initial={reduced ? { opacity: 0 } : undefined}
          animate={reduced ? { opacity: 1 } : undefined}
          transition={reduced ? { duration: DURATION_S.reduced, ease: EASE_OUT } : undefined}
          style={{ y }}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex h-[92dvh] flex-col overflow-hidden rounded-t-2xl border-t border-secondary bg-primary shadow-xl will-change-transform",
            snap === "half" ? "pb-[calc(27dvh+var(--spacing-safe-bottom))]" : "pb-safe-bottom",
          )}
        >
          <div
            role="button"
            tabIndex={0}
            aria-label={m.av_sheet_drag_label()}
            aria-expanded={snap === "tall"}
            onPointerDown={onHandlePointerDown}
            onKeyDown={onHandleKeyDown}
            className="flex min-h-11 w-full shrink-0 cursor-grab touch-none items-center justify-center outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2 active:cursor-grabbing"
          >
            <span aria-hidden="true" className="h-1 w-9 rounded-full bg-quaternary" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </motion.aside>
      </FocusScope>
    </div>
  );
}
