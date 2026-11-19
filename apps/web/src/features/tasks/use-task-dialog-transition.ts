import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import {
  animateFlipFromRect,
  animateFlipToRect,
  cancelFlipAnimation,
  CONTINUOUS_EASING,
  measureRememberedElement,
  peekSharedRect,
} from "#src/lib/shared-element-rect";

type DragState = {
  pointerId: number;
  startY: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  committed: boolean;
};

export function useTaskDialogTransition({
  taskId,
  taskNumber,
  open,
  onOpenChange,
}: {
  taskId: string;
  taskNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const desktop = useBreakpoint("sm");
  const reduced = usePrefersReducedMotion();
  const modalContentRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closingRef = useRef(false);
  const [contentVisible, setContentVisible] = useState(true);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    const modalEl = modalContentRef.current?.parentElement ?? null;
    const targetRect =
      measureRememberedElement(`task-frame:${taskId}`) ??
      measureRememberedElement(`task-frame:${taskNumber}`);
    if (!modalEl || !targetRect || reduced) {
      onOpenChange(false);
      return;
    }
    closingRef.current = true;
    setContentVisible(false);
    const anim = animateFlipToRect(modalEl, targetRect, {
      duration: desktop ? 240 : 340,
      mode: "box",
      includeRadius: true,
    });
    if (!anim) {
      closingRef.current = false;
      onOpenChange(false);
      return;
    }
    const finish = () => {
      closingRef.current = false;
      onOpenChange(false);
    };
    anim.addEventListener("finish", finish, { once: true });
    anim.addEventListener("cancel", finish, { once: true });
  }, [desktop, onOpenChange, reduced, taskId, taskNumber]);

  useLayoutEffect(() => {
    if (!open) {
      closingRef.current = false;
      setDragY(0);
      setDragging(false);
      setContentVisible(true);
      return;
    }
    const modalEl = modalContentRef.current?.parentElement ?? null;
    const frameOrigin =
      peekSharedRect(`task-frame:${taskId}`) ?? peekSharedRect(`task-frame:${taskNumber}`);
    const titleOrigin =
      peekSharedRect(`task-title:${taskId}`) ?? peekSharedRect(`task-title:${taskNumber}`);
    if (!modalEl || !frameOrigin || reduced) {
      setContentVisible(true);
      return;
    }
    const duration = desktop ? 320 : 460;
    setContentVisible(false);
    const anim = animateFlipFromRect(modalEl, frameOrigin, {
      duration,
      mode: "box",
      includeRadius: true,
    });
    if (titleRef.current && titleOrigin) {
      animateFlipFromRect(titleRef.current, titleOrigin, {
        duration,
        mode: "uniform",
      });
    }
    const revealTimer = window.setTimeout(
      () => setContentVisible(true),
      Math.round(duration * 0.45),
    );
    return () => {
      window.clearTimeout(revealTimer);
      if (anim) cancelFlipAnimation(modalEl);
    };
  }, [desktop, open, reduced, taskId, taskNumber]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) onOpenChange(true);
      else requestClose();
    },
    [onOpenChange, requestClose],
  );

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (desktop || reduced || !event.isPrimary) return;
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastTime: performance.now(),
      velocity: 0,
      committed: false,
    };
  };

  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dy = event.clientY - state.startY;
    if (!state.committed) {
      if (dy < 8) return;
      state.committed = true;
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
    }
    const now = performance.now();
    const dt = Math.max(1, now - state.lastTime);
    state.velocity = (event.clientY - state.lastY) / dt;
    state.lastY = event.clientY;
    state.lastTime = now;
    setDragY(Math.max(0, dy));
  };

  const finishHeaderDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const committed = state.committed;
    const dy = Math.max(0, event.clientY - state.startY);
    const velocity = state.velocity;
    dragRef.current = null;
    setDragging(false);
    if (committed && !cancelled && (dy > 110 || velocity > 0.55)) {
      setDragY(0);
      requestClose();
    } else {
      setDragY(0);
    }
  };

  const dragProgress = Math.min(1, dragY / 320);
  const dragScale = 1 - dragProgress * 0.18;
  const dragStyle =
    !desktop && (dragging || dragY > 0)
      ? {
          transform: `translate3d(0, ${dragY}px, 0) scale(${dragScale})`,
          borderRadius: `${Math.round(dragProgress * 20)}px`,
          transition: dragging
            ? undefined
            : `transform 320ms ${CONTINUOUS_EASING}, border-radius 320ms ${CONTINUOUS_EASING}`,
        }
      : undefined;

  return {
    reduced,
    modalContentRef,
    titleRef,
    contentVisible,
    dragStyle,
    requestClose,
    handleOpenChange,
    headerDragProps: {
      onPointerDown: onHeaderPointerDown,
      onPointerMove: onHeaderPointerMove,
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finishHeaderDrag(event, false),
      onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finishHeaderDrag(event, true),
    },
  };
}
