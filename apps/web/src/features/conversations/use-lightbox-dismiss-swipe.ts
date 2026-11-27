import { useEffect, useRef, type PointerEvent, type RefObject } from "react";
import { DURATION_MS, EASE_CSS } from "#src/utils/motion-tokens";

export const MIN_ZOOM_SCALE = 1;
export const MAX_ZOOM_SCALE = 4;
export const ZOOM_STEP = 0.25;
export const DOUBLE_TAP_ZOOM_STEP = 1.5;
export const KEYBOARD_PAN_STEP_PX = 80;
export const ZOOM_ANIMATION_MS = 220;

const DRAG_DISMISS_DISTANCE_PX = 96;
const DRAG_DISMISS_VELOCITY = 0.45;
const DRAG_SCALE_RANGE_PX = 260;
const DRAG_MIN_SCALE = 0.82;
const VELOCITY_WINDOW_MS = 100;
const SWIPE_STEP_DISTANCE_PX = 72;
const SWIPE_STEP_VELOCITY = 0.45;

export function formatZoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

export function resolveSwipeStep(
  offsetX: number,
  velocityX: number,
  index: number,
  imageCount: number,
): -1 | 0 | 1 {
  if (imageCount <= 1) return 0;
  let direction: -1 | 0 | 1 = 0;
  if (offsetX <= -SWIPE_STEP_DISTANCE_PX || (offsetX < -16 && velocityX <= -SWIPE_STEP_VELOCITY)) {
    direction = 1;
  } else if (
    offsetX >= SWIPE_STEP_DISTANCE_PX ||
    (offsetX > 16 && velocityX >= SWIPE_STEP_VELOCITY)
  ) {
    direction = -1;
  }
  if (direction === -1 && index <= 0) return 0;
  if (direction === 1 && index >= imageCount - 1) return 0;
  return direction;
}

type DragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  mode: "pending" | "dismiss" | "swipe";
  dismissY: number;
  swipeX: number;
  samples: { t: number; x: number; y: number }[];
};

function rubberbandOffset(offset: number, span: number): number {
  const dimension = Math.max(span, 1);
  const abs = Math.abs(offset);
  return Math.sign(offset) * ((abs * 0.35 * dimension) / (dimension + 0.35 * abs));
}

export function useLightboxDismissSwipe({
  stageRef,
  zoomedRef,
  imageId,
  index,
  imageCount,
  paged,
  failed,
  closing,
  commentsShown,
  reduced,
  onDragProgress,
  onRequestDragClose,
  onStep,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  zoomedRef: RefObject<boolean>;
  imageId: string;
  index: number;
  imageCount: number;
  paged: boolean;
  failed: boolean;
  closing: boolean;
  commentsShown: boolean;
  reduced: boolean;
  onDragProgress: (progress: number) => void;
  onRequestDragClose: (fromTransform?: string) => void;
  onStep: (delta: -1 | 1) => void;
}) {
  const pointersRef = useRef<Set<number>>(new Set());
  const sessionRef = useRef<DragSession | null>(null);
  const swipeTimerRef = useRef<number | null>(null);

  const clearTimers = () => {
    if (swipeTimerRef.current !== null) {
      window.clearTimeout(swipeTimerRef.current);
      swipeTimerRef.current = null;
    }
  };

  const resetVisuals = () => {
    clearTimers();
    const img = stageRef.current?.querySelector<HTMLElement>("img");
    if (img) {
      img.style.transition = "";
      img.style.transform = "";
    }
    const wrapper = stageRef.current?.querySelector<HTMLElement>(".react-transform-wrapper");
    if (wrapper) {
      wrapper.style.transition = "";
      wrapper.style.transform = "translate3d(0, 0, 0)";
    }
    onDragProgress(0);
  };

  useEffect(() => {
    pointersRef.current.clear();
    sessionRef.current = null;
    resetVisuals();
  }, [imageId]);

  useEffect(() => clearTimers, []);

  const abortActive = () => {
    if (!sessionRef.current) return;
    sessionRef.current = null;
    resetVisuals();
  };

  const onStagePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (failed || closing || zoomedRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, a")) return;

    pointersRef.current.add(event.pointerId);
    if (pointersRef.current.size > 1) {
      abortActive();
      return;
    }

    clearTimers();
    sessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      mode: "pending",
      dismissY: 0,
      swipeX: 0,
      samples: [{ t: event.timeStamp, x: event.clientX, y: event.clientY }],
    };
  };

  const onStagePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (zoomedRef.current || pointersRef.current.size > 1) {
      abortActive();
      return;
    }

    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    session.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    while (
      session.samples.length > 2 &&
      event.timeStamp - session.samples[0]!.t > VELOCITY_WINDOW_MS
    ) {
      session.samples.shift();
    }

    if (session.mode === "pending") {
      if (Math.hypot(dx, dy) < 8) return;
      if (!reduced && !commentsShown && dy > 0 && Math.abs(dy) >= Math.abs(dx) * 1.2) {
        session.mode = "dismiss";
      } else if (paged && Math.abs(dx) > Math.abs(dy) * 1.2) {
        session.mode = "swipe";
      } else {
        return;
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
    }

    if (session.mode === "dismiss") {
      session.dismissY = Math.max(0, dy);
      const progress = Math.min(1, session.dismissY / DRAG_SCALE_RANGE_PX);
      const scale = 1 - progress * (1 - DRAG_MIN_SCALE);
      const img = stageRef.current?.querySelector<HTMLElement>("img");
      if (img) {
        img.style.transition = "none";
        img.style.transform = `translate3d(${dx * 0.25}px, ${session.dismissY}px, 0) scale(${scale})`;
      }
      onDragProgress(progress);
      return;
    }

    const wrapper = stageRef.current?.querySelector<HTMLElement>(".react-transform-wrapper");
    const width = stageRef.current?.clientWidth ?? 390;
    const atEdge = (index === 0 && dx > 0) || (index === imageCount - 1 && dx < 0);
    session.swipeX = atEdge ? rubberbandOffset(dx, width) : dx;
    if (wrapper) {
      wrapper.style.transition = "none";
      wrapper.style.transform = `translate3d(${session.swipeX}px, 0, 0)`;
    }
  };

  const onStagePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}

    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    sessionRef.current = null;

    if (session.mode === "pending" || zoomedRef.current) return;

    const first = session.samples[0]!;
    const elapsed = event.timeStamp - first.t;

    if (session.mode === "dismiss") {
      const vy = elapsed > 0 ? (event.clientY - first.y) / elapsed : 0;
      const img = stageRef.current?.querySelector<HTMLElement>("img");
      const shouldDismiss =
        event.type === "pointerup" &&
        (session.dismissY > DRAG_DISMISS_DISTANCE_PX ||
          (session.dismissY > 16 && vy > DRAG_DISMISS_VELOCITY));
      if (shouldDismiss) {
        const fromTransform = img?.style.transform || undefined;
        if (img) {
          img.style.transition = "";
          img.style.transform = "";
        }
        onRequestDragClose(fromTransform);
        return;
      }
      if (img) {
        img.style.transition = "transform calc(var(--duration-md) * 1.5) var(--ease-spring)";
        img.style.transform = "translate3d(0, 0, 0) scale(1)";
        window.setTimeout(
          () => {
            if (img.isConnected) {
              img.style.transition = "";
              img.style.transform = "";
            }
          },
          Math.round(DURATION_MS.md * 1.5) + 20,
        );
      }
      onDragProgress(0);
      return;
    }

    const vx = elapsed > 0 ? (event.clientX - first.x) / elapsed : 0;
    const stepDir =
      event.type === "pointerup" ? resolveSwipeStep(session.swipeX, vx, index, imageCount) : 0;
    const wrapper = stageRef.current?.querySelector<HTMLElement>(".react-transform-wrapper");
    if (stepDir !== 0) {
      if (wrapper) {
        wrapper.style.transition = "";
        wrapper.style.transform = "translate3d(0, 0, 0)";
      }
      onStep(stepDir);
      return;
    }
    if (wrapper) {
      if (reduced) {
        wrapper.style.transition = "";
        wrapper.style.transform = "translate3d(0, 0, 0)";
        return;
      }
      wrapper.style.transition = `transform ${ZOOM_ANIMATION_MS}ms ${EASE_CSS.outStrong}`;
      wrapper.style.transform = "translate3d(0, 0, 0)";
      swipeTimerRef.current = window.setTimeout(() => {
        swipeTimerRef.current = null;
        if (wrapper.isConnected) {
          wrapper.style.transition = "";
          wrapper.style.transform = "translate3d(0, 0, 0)";
        }
      }, ZOOM_ANIMATION_MS + 20);
    }
  };

  return {
    onStagePointerDown,
    onStagePointerMove,
    onStagePointerEnd,
  };
}
