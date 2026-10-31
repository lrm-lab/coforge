import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  DEFAULT_SIDE_PANEL_WIDTH,
  MIN_SIDE_PANEL_WIDTH,
  readStoredSidePanelWidth,
  writeStoredSidePanelWidth,
} from "./record-side-panel-width";

/**
 * The Record side panel's width: the stored width, clamped to half its parent, eased open and
 * closed, and changed by dragging or arrowing its left edge (`resizeHandle`).
 */
export function useSidePanelWidth(open: boolean) {
  const asideRef = useRef<HTMLElement>(null);
  const panelDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const panelWidthRef = useRef(DEFAULT_SIDE_PANEL_WIDTH);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_SIDE_PANEL_WIDTH);
  panelWidthRef.current = panelWidth;
  const [displayWidth, setDisplayWidth] = useState(() => (open ? DEFAULT_SIDE_PANEL_WIDTH : 0));
  const [resizing, setResizing] = useState(false);
  const wasOpenRef = useRef(open);

  useLayoutEffect(() => {
    const stored = readStoredSidePanelWidth();
    const parent = asideRef.current?.parentElement;
    const max = parent ? Math.floor(parent.clientWidth / 2) : stored;
    const next = Math.min(Math.max(stored, MIN_SIDE_PANEL_WIDTH), max);
    setPanelWidth(next);
    if (open) setDisplayWidth(next);
  }, []);

  useLayoutEffect(() => {
    if (open) {
      const shouldAnimateIn = !wasOpenRef.current;
      wasOpenRef.current = true;
      if (shouldAnimateIn) {
        setDisplayWidth(0);
        const frame = requestAnimationFrame(() => setDisplayWidth(panelWidth));
        return () => cancelAnimationFrame(frame);
      }
      setDisplayWidth(panelWidth);
      return;
    }
    wasOpenRef.current = false;
    setDisplayWidth(0);
  }, [open, panelWidth]);

  useEffect(() => {
    function clampToParent() {
      const parent = asideRef.current?.parentElement;
      if (!parent) return;
      const max = Math.floor(parent.clientWidth / 2);
      setPanelWidth((current) => Math.min(Math.max(current, MIN_SIDE_PANEL_WIDTH), max));
    }
    window.addEventListener("resize", clampToParent);
    return () => window.removeEventListener("resize", clampToParent);
  }, []);

  function commitPanelWidth(width: number) {
    panelWidthRef.current = width;
    setPanelWidth(width);
    setDisplayWidth(width);
  }

  function onPanelResizePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    panelDragRef.current = { startX: event.clientX, startWidth: panelWidthRef.current };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // Drop the open/close ease before the first move, so a move in this frame cannot restart it.
    if (asideRef.current) asideRef.current.style.transition = "none";
    setResizing(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; the move handler still tracks clientX.
    }
  }

  function onPanelResizePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (!drag) return;
    const parent = asideRef.current?.parentElement;
    const max = parent ? Math.floor(parent.clientWidth / 2) : Math.floor(window.innerWidth / 2);
    // Dragging the left edge leftward widens the panel. Integer pixels keep the pinned right edge still.
    const next = drag.startWidth + (drag.startX - event.clientX);
    commitPanelWidth(Math.round(Math.min(Math.max(next, MIN_SIDE_PANEL_WIDTH), max)));
  }

  function onPanelResizePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!panelDragRef.current) return;
    panelDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setResizing(false);
    writeStoredSidePanelWidth(panelWidthRef.current);
  }

  function onPanelResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const parent = asideRef.current?.parentElement;
    const max = parent ? Math.floor(parent.clientWidth / 2) : Math.floor(window.innerWidth / 2);
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPanelWidth((current) => {
        const next = Math.min(current + step, max);
        writeStoredSidePanelWidth(next);
        return next;
      });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setPanelWidth((current) => {
        const next = Math.max(current - step, MIN_SIDE_PANEL_WIDTH);
        writeStoredSidePanelWidth(next);
        return next;
      });
    }
  }

  return {
    asideRef,
    panelWidth,
    displayWidth,
    resizing,
    resizeHandle: {
      onPointerDown: onPanelResizePointerDown,
      onPointerMove: onPanelResizePointerMove,
      onPointerUp: onPanelResizePointerUp,
      onPointerCancel: onPanelResizePointerUp,
      onKeyDown: onPanelResizeKeyDown,
    },
  };
}
