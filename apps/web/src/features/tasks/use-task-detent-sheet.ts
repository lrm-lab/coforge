import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent as ReactUIEvent,
} from "react";

import { opensKeyboard } from "#src/hooks/use-keyboard-field-focused";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import {
  applyTopRubberBand,
  computeDetentMetrics,
  computeDetentPose,
  DETENT_EASE_CSS,
  DETENT_REDUCED_MS,
  detentTargetY,
  parseTranslateY,
  resolveDetentRelease,
  resolveTransitionDurationMs,
  shouldPromoteDetentOnScroll,
  updateDragVelocity,
  type DetentMetrics,
  type DetentTransitionPhase,
  type TaskDetent,
} from "./task-detent-physics";

type SheetLifecycle = "closed" | "open" | "exiting";

type ActiveDrag = {
  pointerId: number;
  startClientY: number;
  startSheetY: number;
  lastClientY: number;
  lastTime: number;
  velocity: number;
  currentY: number;
  startDetent: TaskDetent;
};

export type UseTaskDetentSheetOptions = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detent?: TaskDetent;
  defaultDetent: TaskDetent;
  onDetentChange?: (detent: TaskDetent) => void;
  autoExpandOnComposerFocus: boolean;
  dismissRef?: RefObject<(() => void) | null>;
};

const INTERACTIVE_DRAG_IGNORE =
  "button, a, input, textarea, select, [role='button'], [role='menuitem'], [data-no-sheet-drag]";

function readLiveTranslateY(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return 0;
  if (typeof DOMMatrixReadOnly !== "undefined") {
    const m42 = new DOMMatrixReadOnly(transform).m42;
    return Number.isFinite(m42) ? m42 : 0;
  }
  return parseTranslateY(transform);
}

export function useTaskDetentSheet({
  open,
  onOpenChange,
  detent,
  defaultDetent,
  onDetentChange,
  autoExpandOnComposerFocus,
  dismissRef,
}: UseTaskDetentSheetOptions) {
  const reducedMotion = usePrefersReducedMotion();
  const isControlled = detent !== undefined;
  const [internalDetent, setInternalDetent] = useState<TaskDetent>(defaultDetent);
  const [lifecycle, setLifecycle] = useState<SheetLifecycle>(open ? "open" : "closed");
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      if (lifecycle === "closed" && !isControlled) setInternalDetent(defaultDetent);
      setLifecycle("open");
    } else if (lifecycle === "open") {
      setLifecycle("exiting");
    }
  }

  const effectiveDetent = isControlled ? detent : internalDetent;
  const rendered = lifecycle !== "closed";

  const [sheetEl, setSheetEl] = useState<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const attachSheetRef = useCallback((node: HTMLDivElement | null) => {
    sheetRef.current = node;
    setSheetEl(node);
  }, []);
  const scrimRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const enterFrameRef = useRef<number | null>(null);
  const scrollHistoryRef = useRef<WeakMap<EventTarget, number>>(new WeakMap());
  const suppressScrollPromoteUntilRef = useRef(0);
  const hasEnteredRef = useRef(false);
  const caughtDuringExitRef = useRef(false);
  const openRef = useRef(open);
  const detentRef = useRef<TaskDetent>(effectiveDetent);
  const reducedRef = useRef(reducedMotion);
  const onOpenChangeRef = useRef(onOpenChange);
  const onDetentChangeRef = useRef(onDetentChange);

  useLayoutEffect(() => {
    openRef.current = open;
    detentRef.current = effectiveDetent;
    reducedRef.current = reducedMotion;
    onOpenChangeRef.current = onOpenChange;
    onDetentChangeRef.current = onDetentChange;
  }, [open, effectiveDetent, reducedMotion, onOpenChange, onDetentChange]);

  const clearScheduledFrames = useCallback(() => {
    if (enterFrameRef.current !== null) {
      cancelAnimationFrame(enterFrameRef.current);
      enterFrameRef.current = null;
    }
  }, []);

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const measureMetrics = useCallback((): DetentMetrics | null => {
    const sheet = sheetRef.current;
    if (!sheet) return null;
    const height = sheet.getBoundingClientRect().height;
    if (height <= 0) return null;
    return computeDetentMetrics(height);
  }, []);

  const applyPose = useCallback(
    (
      yPx: number,
      {
        phase,
        dragging,
        instant = false,
      }: { phase: DetentTransitionPhase; dragging: boolean; instant?: boolean },
    ) => {
      const sheet = sheetRef.current;
      const metrics = measureMetrics();
      if (!sheet || !metrics) return;

      const scrim = scrimRef.current;
      const composerEl = composerRef.current;
      const bodyEl = bodyRef.current;
      const reduced = reducedRef.current;
      const pose = computeDetentPose(yPx, metrics);
      const durationMs = resolveTransitionDurationMs(phase, reduced);

      sheet.dataset.dragging = dragging ? "true" : "false";
      sheet.dataset.phase = phase;
      if (scrim) {
        scrim.dataset.dragging = dragging ? "true" : "false";
        scrim.dataset.phase = phase;
      }

      if (reduced && !dragging) {
        const opacityTransition = instant ? "none" : `opacity ${DETENT_REDUCED_MS}ms ease-out`;
        const isExit = phase === "exit";
        sheet.style.transition = opacityTransition;
        sheet.style.transform = `translate3d(0, ${isExit ? readLiveTranslateY(sheet) : pose.sheetY}px, 0)`;
        sheet.style.opacity = isExit ? "0" : "1";
        if (composerEl) {
          composerEl.style.transition = "none";
          composerEl.style.transform = `translate3d(0, ${-pose.composerPin}px, 0)`;
        }
        if (scrim) {
          scrim.style.transition = opacityTransition;
          scrim.style.opacity = isExit ? "0" : pose.scrimOpacity.toFixed(3);
        }
        if (bodyEl && !isExit) {
          bodyEl.style.paddingBottom = pose.composerPin > 0 ? `${pose.composerPin}px` : "";
        }
        return;
      }

      const transformTransition =
        dragging || instant ? "none" : `transform ${durationMs}ms ${DETENT_EASE_CSS}`;
      const scrimTransition =
        dragging || instant ? "none" : `opacity ${durationMs}ms ${DETENT_EASE_CSS}`;

      sheet.style.transition = transformTransition;
      sheet.style.opacity = "1";
      sheet.style.transform = `translate3d(0, ${pose.sheetY}px, 0)`;

      if (composerEl) {
        composerEl.style.transition = transformTransition;
        composerEl.style.transform = `translate3d(0, ${-pose.composerPin}px, 0)`;
      }

      if (scrim) {
        scrim.style.transition = scrimTransition;
        scrim.style.opacity = pose.scrimOpacity.toFixed(3);
      }

      if (bodyEl && !dragging && phase !== "exit") {
        bodyEl.style.paddingBottom = pose.composerPin > 0 ? `${pose.composerPin}px` : "";
      }
    },
    [measureMetrics],
  );

  const commitDetent = useCallback(
    (next: TaskDetent) => {
      if (next === "half") {
        scrollHistoryRef.current = new WeakMap();
        suppressScrollPromoteUntilRef.current = performance.now() + 150;
      }
      detentRef.current = next;
      if (!isControlled) setInternalDetent(next);
      onDetentChangeRef.current?.(next);
    },
    [isControlled],
  );

  const requestDismiss = useCallback(() => {
    setLifecycle((current) => (current === "open" ? "exiting" : current));
  }, []);

  useLayoutEffect(() => {
    if (!dismissRef) return;
    dismissRef.current = requestDismiss;
    return () => {
      dismissRef.current = null;
    };
  }, [dismissRef, requestDismiss]);

  useLayoutEffect(() => {
    if (lifecycle === "closed") {
      clearScheduledFrames();
      clearExitTimer();
      hasEnteredRef.current = false;
      caughtDuringExitRef.current = false;
      dragRef.current = null;
      scrollHistoryRef.current = new WeakMap();
      suppressScrollPromoteUntilRef.current = 0;
      return;
    }

    if (!sheetEl) return;

    if (lifecycle === "exiting") {
      clearScheduledFrames();
      clearExitTimer();
      const metrics = measureMetrics();
      const durationMs = resolveTransitionDurationMs("exit", reducedRef.current);
      if (metrics) {
        applyPose(metrics.closedY, { phase: "exit", dragging: false });
      }
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null;
        hasEnteredRef.current = false;
        setLifecycle("closed");
        if (openRef.current) onOpenChangeRef.current(false);
      }, durationMs + 16);
      return () => {
        clearExitTimer();
      };
    }

    clearExitTimer();
    if (caughtDuringExitRef.current) {
      caughtDuringExitRef.current = false;
      return;
    }

    const metrics = measureMetrics();
    if (!metrics) return;
    const targetY = detentTargetY(detentRef.current, metrics);

    if (!hasEnteredRef.current) {
      clearScheduledFrames();
      if (reducedRef.current) {
        const scrim = scrimRef.current;
        const composerEl = composerRef.current;
        const bodyEl = bodyRef.current;
        const pose = computeDetentPose(targetY, metrics);
        sheetEl.style.transition = "none";
        sheetEl.style.transform = `translate3d(0, ${pose.sheetY}px, 0)`;
        sheetEl.style.opacity = "0";
        if (composerEl) {
          composerEl.style.transition = "none";
          composerEl.style.transform = `translate3d(0, ${-pose.composerPin}px, 0)`;
        }
        if (scrim) {
          scrim.style.transition = "none";
          scrim.style.opacity = "0";
        }
        if (bodyEl) {
          bodyEl.style.paddingBottom = pose.composerPin > 0 ? `${pose.composerPin}px` : "";
        }
      } else {
        applyPose(metrics.closedY, { phase: "enter", dragging: false, instant: true });
      }
      void sheetEl.offsetHeight;
      enterFrameRef.current = requestAnimationFrame(() => {
        enterFrameRef.current = null;
        if (dragRef.current || sheetRef.current !== sheetEl) return;
        void sheetEl.offsetHeight;
        const liveMetrics = measureMetrics();
        if (!liveMetrics) return;
        hasEnteredRef.current = true;
        applyPose(detentTargetY(detentRef.current, liveMetrics), {
          phase: "enter",
          dragging: false,
        });
      });
      return () => {
        clearScheduledFrames();
      };
    }

    if (!dragRef.current) {
      applyPose(targetY, { phase: "snap", dragging: false });
    }
    return undefined;
  }, [lifecycle, sheetEl, applyPose, clearExitTimer, clearScheduledFrames, measureMetrics]);

  useLayoutEffect(() => {
    if (effectiveDetent === "half") {
      scrollHistoryRef.current = new WeakMap();
      suppressScrollPromoteUntilRef.current = performance.now() + 150;
    }
    if (lifecycle !== "open" || !hasEnteredRef.current || dragRef.current) return;
    const metrics = measureMetrics();
    if (!metrics) return;
    applyPose(detentTargetY(effectiveDetent, metrics), { phase: "snap", dragging: false });
  }, [effectiveDetent, lifecycle, applyPose, measureMetrics]);

  useEffect(() => {
    if (!rendered || !sheetEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (dragRef.current || lifecycle !== "open") return;
      const metrics = measureMetrics();
      if (!metrics) return;
      if (!hasEnteredRef.current) {
        if (enterFrameRef.current !== null) return;
        hasEnteredRef.current = true;
        applyPose(detentTargetY(detentRef.current, metrics), {
          phase: "enter",
          dragging: false,
        });
        return;
      }
      applyPose(detentTargetY(detentRef.current, metrics), {
        phase: "snap",
        dragging: false,
        instant: true,
      });
    });
    observer.observe(sheetEl);
    return () => {
      observer.disconnect();
    };
  }, [rendered, sheetEl, lifecycle, applyPose, measureMetrics]);

  useEffect(() => {
    return () => {
      clearScheduledFrames();
      clearExitTimer();
    };
  }, [clearScheduledFrames, clearExitTimer]);

  const handleGrabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE_DRAG_IGNORE)) {
        return;
      }
      if (dragRef.current !== null) return;

      const sheet = sheetRef.current;
      if (!sheet) return;
      if (lifecycle === "exiting" && !openRef.current) return;

      clearScheduledFrames();
      clearExitTimer();
      hasEnteredRef.current = true;

      if (lifecycle === "exiting") {
        caughtDuringExitRef.current = true;
        setLifecycle("open");
      }

      const startSheetY = readLiveTranslateY(sheet);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}

      dragRef.current = {
        pointerId: event.pointerId,
        startClientY: event.clientY,
        startSheetY,
        lastClientY: event.clientY,
        lastTime: performance.now(),
        velocity: 0,
        currentY: startSheetY,
        startDetent: detentRef.current,
      };

      applyPose(startSheetY, { phase: "snap", dragging: true });
    },
    [applyPose, clearExitTimer, clearScheduledFrames, lifecycle],
  );

  const handleGrabPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const now = performance.now();
      drag.velocity = updateDragVelocity(
        drag.velocity,
        event.clientY - drag.lastClientY,
        now - drag.lastTime,
      );
      drag.lastClientY = event.clientY;
      drag.lastTime = now;

      const rawY = drag.startSheetY + (event.clientY - drag.startClientY);
      drag.currentY = applyTopRubberBand(rawY);
      applyPose(drag.currentY, { phase: "snap", dragging: true });
    },
    [applyPose],
  );

  const finishGrabDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;

      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {}

      const metrics = measureMetrics();
      if (!metrics) return;

      const resolution = resolveDetentRelease({
        startDetent: drag.startDetent,
        currentY: drag.currentY,
        velocity: drag.velocity,
        metrics,
        cancelled,
      });

      if (resolution === "dismiss") {
        requestDismiss();
        return;
      }

      commitDetent(resolution);
      applyPose(detentTargetY(resolution, metrics), { phase: "snap", dragging: false });
    },
    [applyPose, commitDetent, measureMetrics, requestDismiss],
  );

  const handleComposerFocusCapture = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      if (!autoExpandOnComposerFocus || lifecycle !== "open" || detentRef.current !== "half") {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!opensKeyboard(target)) return;
      commitDetent("full");
    },
    [autoExpandOnComposerFocus, commitDetent, lifecycle],
  );

  const handleBodyScrollCapture = useCallback(
    (event: ReactUIEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const previousScrollTop = scrollHistoryRef.current.get(target) ?? 0;
      const currentScrollTop = target.scrollTop;
      scrollHistoryRef.current.set(target, currentScrollTop);

      if (
        lifecycle !== "open" ||
        dragRef.current !== null ||
        !hasEnteredRef.current ||
        performance.now() < suppressScrollPromoteUntilRef.current
      ) {
        return;
      }
      if (
        shouldPromoteDetentOnScroll({
          detent: detentRef.current,
          previousScrollTop,
          currentScrollTop,
        })
      ) {
        commitDetent("full");
      }
    },
    [commitDetent, lifecycle],
  );

  return {
    effectiveDetent,
    lifecycle,
    rendered,
    attachSheetRef,
    scrimRef,
    bodyRef,
    composerRef,
    requestDismiss,
    handleGrabPointerDown,
    handleGrabPointerMove,
    finishGrabDrag,
    handleComposerFocusCapture,
    handleBodyScrollCapture,
  };
}
