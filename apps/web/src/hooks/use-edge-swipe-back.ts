import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { DURATION_MS } from "#src/utils/motion-tokens";

const EDGE_MIN_X = 16;
const EDGE_MAX_X = 64;
const COMMIT_DX = 10;
const COMPLETE_PROGRESS = 0.32;
const COMPLETE_VELOCITY = 0.45;
const SETTLE_DURATION_MS = Math.round(DURATION_MS.md * 1.5);

export function shouldCompleteSwipeBack(progress: number, velocityPxPerMs: number): boolean {
  return progress >= COMPLETE_PROGRESS || velocityPxPerMs >= COMPLETE_VELOCITY;
}

export function useEdgeSwipeBack({
  enabled,
  onBack,
  onProgress,
  onEnd,
}: {
  enabled: boolean;
  onBack: () => void;
  onProgress?: (progress: number) => void;
  onEnd?: (completed: boolean) => void;
}) {
  const [dragProgress, setDragProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const settleTimerRef = useRef<number | null>(null);
  const onProgressRef = useRef(onProgress);
  const onEndRef = useRef(onEnd);
  useEffect(() => {
    onProgressRef.current = onProgress;
    onEndRef.current = onEnd;
  }, [onProgress, onEnd]);
  const stateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastTime: number;
    velocity: number;
    width: number;
    committed: boolean;
  } | null>(null);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearSettleTimer();
      if (stateRef.current?.committed) {
        stateRef.current = null;
        onEndRef.current?.(false);
      }
    };
  }, [clearSettleTimer]);

  useEffect(() => {
    if (enabled) return;
    if (stateRef.current) {
      const wasCommitted = stateRef.current.committed;
      stateRef.current = null;
      if (wasCommitted) {
        setDragging(false);
        if (!onProgressRef.current) setDragProgress(0);
        onEndRef.current?.(false);
      }
    }
  }, [enabled]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!enabled || !event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      if (localX < EDGE_MIN_X || localX > EDGE_MAX_X) return;
      clearSettleTimer();
      setSettling(false);
      stateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastTime: performance.now(),
        velocity: 0,
        width: Math.max(rect.width, 1),
        committed: false,
      };
    },
    [clearSettleTimer, enabled],
  );

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const state = stateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.committed) {
      if (Math.abs(dy) > COMMIT_DX && Math.abs(dy) > Math.abs(dx)) {
        stateRef.current = null;
        return;
      }
      if (dx < COMMIT_DX || dx < Math.abs(dy) * 1.4) return;
      state.committed = true;
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
    }
    const now = performance.now();
    const dt = Math.max(1, now - state.lastTime);
    state.velocity = (event.clientX - state.lastX) / dt;
    state.lastX = event.clientX;
    state.lastTime = now;
    const progress = Math.max(0, Math.min(1, dx / state.width));
    if (onProgressRef.current) {
      onProgressRef.current(progress);
    } else {
      setDragProgress(progress);
    }
  }, []);

  const finish = useCallback(
    (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const committed = state.committed;
      const progress = Math.max(0, Math.min(1, (event.clientX - state.startX) / state.width));
      const velocity = state.velocity;
      stateRef.current = null;
      const completed = committed && !cancelled && shouldCompleteSwipeBack(progress, velocity);
      if (committed) {
        setDragging(false);
        if (!onProgressRef.current) setDragProgress(0);
        onEndRef.current?.(completed);
      }
      if (completed) {
        onBack();
      } else if (committed) {
        clearSettleTimer();
        setSettling(true);
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = null;
          setSettling(false);
        }, SETTLE_DURATION_MS);
      }
    },
    [clearSettleTimer, onBack],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => finish(event, false),
    [finish],
  );

  const onPointerCancel = useCallback(
    (event: PointerEvent<HTMLElement>) => finish(event, true),
    [finish],
  );

  return {
    bind: enabled ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } : {},
    dragProgress,
    dragging,
    settling,
  };
}
