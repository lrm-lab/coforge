import { useRef, type PointerEvent, type RefObject } from "react";
import { DURATION_MS } from "#src/utils/motion-tokens";

const DRAG_DISMISS_DISTANCE_PX = 96;
const DRAG_DISMISS_VELOCITY = 0.45;
const DRAG_SCALE_RANGE_PX = 260;
const DRAG_MIN_SCALE = 0.82;
const VELOCITY_WINDOW_MS = 100;

export function useLightboxDismissSwipe({
  stageRef,
  reduced,
  closing,
  commentsShown,
  onDragProgress,
  requestDragClose,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  reduced: boolean;
  closing: boolean;
  commentsShown: boolean;
  onDragProgress: (progress: number) => void;
  requestDragClose: (fromTransform?: string) => void;
}) {
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    dx: number;
    dy: number;
    samples: { t: number; y: number }[];
  } | null>(null);

  const onStagePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (reduced || closing || commentsShown || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      dx: 0,
      dy: 0,
      samples: [{ t: event.timeStamp, y: event.clientY }],
    };
  };

  const onStagePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.active) {
      if (dy < 8 || Math.abs(dy) < Math.abs(dx) * 1.2) return;
      current.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    current.dx = dx;
    current.dy = Math.max(0, dy);
    current.samples.push({ t: event.timeStamp, y: event.clientY });
    while (
      current.samples.length > 2 &&
      event.timeStamp - current.samples[0]!.t > VELOCITY_WINDOW_MS
    )
      current.samples.shift();
    const progress = Math.min(1, current.dy / DRAG_SCALE_RANGE_PX);
    const scale = 1 - progress * (1 - DRAG_MIN_SCALE);
    const img = stageRef.current?.querySelector<HTMLElement>("img");
    if (img) {
      img.style.transition = "none";
      img.style.transform = `translate3d(${dx * 0.25}px, ${current.dy}px, 0) scale(${scale})`;
    }
    onDragProgress(progress);
  };

  const onStagePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!current.active) return;
    const first = current.samples[0]!;
    const elapsed = event.timeStamp - first.t;
    const velocity = elapsed > 0 ? (event.clientY - first.y) / elapsed : 0;
    const img = stageRef.current?.querySelector<HTMLElement>("img");
    const shouldDismiss =
      event.type === "pointerup" &&
      (current.dy > DRAG_DISMISS_DISTANCE_PX ||
        (current.dy > 16 && velocity > DRAG_DISMISS_VELOCITY));
    if (shouldDismiss) {
      const fromTransform = img?.style.transform || undefined;
      if (img) {
        img.style.transition = "";
        img.style.transform = "";
      }
      requestDragClose(fromTransform);
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
  };

  return { onStagePointerDown, onStagePointerMove, onStagePointerEnd };
}
