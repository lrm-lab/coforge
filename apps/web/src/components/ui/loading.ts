import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const SHOW_DELAY_MS = 150;
const MIN_VISIBLE_MS = 400;
const EXIT_DURATION_MS = 200;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useLoadingVisible(active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);

    if (active) {
      showTimer.current = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, SHOW_DELAY_MS);

      return () => clearTimeout(showTimer.current);
    }

    if (shownAt.current === 0) {
      setVisible(false);
      return;
    }

    const remaining = MIN_VISIBLE_MS - (Date.now() - shownAt.current);
    shownAt.current = 0;

    if (remaining <= 0) {
      setVisible(false);
      return;
    }

    hideTimer.current = setTimeout(() => setVisible(false), remaining);

    return () => clearTimeout(hideTimer.current);
  }, [active]);

  return visible;
}

export function useButtonLoadingTransition<TContent>(
  loadingProp: boolean | undefined,
  elementRef: RefObject<HTMLElement | null>,
  content: TContent,
  measureDeps: readonly unknown[],
) {
  const canLoad = loadingProp !== undefined;
  const loading = Boolean(loadingProp);
  const showIndicator = useLoadingVisible(loading);
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);
  const [frozenContent, setFrozenContent] = useState<TContent | null>(null);
  const [exiting, setExiting] = useState(false);
  const idleWidthRef = useRef<number | null>(null);
  const idleContentRef = useRef<TContent | null>(null);
  const wasVisibleRef = useRef(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const captureIdleWidth = useCallback(() => {
    if (loading) return;
    const width = elementRef.current?.getBoundingClientRect().width ?? 0;
    if (width > 0) idleWidthRef.current = width;
  }, [loading, elementRef]);

  useIsomorphicLayoutEffect(() => {
    if (!canLoad || loading || showIndicator || exiting) return;
    idleContentRef.current = content;
    const width = elementRef.current?.getBoundingClientRect().width ?? 0;
    if (width > 0) idleWidthRef.current = width;
  }, [canLoad, loading, showIndicator, exiting, elementRef, ...measureDeps]);

  useIsomorphicLayoutEffect(() => {
    clearTimeout(exitTimerRef.current);

    if (loading || showIndicator) {
      if (showIndicator) wasVisibleRef.current = true;
      setExiting(false);
      if (idleWidthRef.current !== null) {
        setLockedWidth((previous) => previous ?? idleWidthRef.current);
      }
      if (idleContentRef.current !== null) {
        setFrozenContent((previous) => previous ?? idleContentRef.current);
      }
      return;
    }

    if (wasVisibleRef.current) {
      wasVisibleRef.current = false;
      setExiting(true);
      exitTimerRef.current = setTimeout(() => {
        setExiting(false);
        setLockedWidth(null);
        setFrozenContent(null);
      }, EXIT_DURATION_MS);
      return () => clearTimeout(exitTimerRef.current);
    }

    setLockedWidth(null);
    setFrozenContent(null);
  }, [loading, showIndicator]);

  return {
    showIndicator,
    loadingActive: loading || showIndicator || exiting,
    lockedWidth,
    frozenContent,
    captureIdleWidth,
  };
}
