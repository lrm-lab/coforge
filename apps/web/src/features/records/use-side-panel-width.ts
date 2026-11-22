import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useResizeObserver } from "#src/hooks/use-resize-observer";

import {
  canDockSidePanel,
  DEFAULT_SIDE_PANEL_WIDTH,
  fitSidePanelWidth,
  maxDockedSidePanelWidth,
  MIN_SIDE_PANEL_WIDTH,
  readRootFontSizePx,
  readStoredSidePanelWidth,
  roundSidePanelRem,
  writeStoredSidePanelWidth,
} from "./record-side-panel-width";

export function useSidePanelWidth(open: boolean) {
  const asideRef = useRef<HTMLElement>(null);
  const parentRef = useRef<HTMLElement | null>(null);
  const panelDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const panelWidthRef = useRef(DEFAULT_SIDE_PANEL_WIDTH);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_SIDE_PANEL_WIDTH);
  panelWidthRef.current = panelWidth;
  const beside = useBreakpoint("lg");
  const [docked, setDocked] = useState(beside);

  const clampToParent = useCallback(() => {
    const parent = asideRef.current?.parentElement ?? null;
    parentRef.current = parent;
    if (!parent) return;
    const rootPx = readRootFontSizePx();
    const nextDocked = canDockSidePanel(parent.clientWidth, beside, rootPx);
    setDocked(nextDocked);
    const preferred = nextDocked ? readStoredSidePanelWidth() : panelWidthRef.current;
    setPanelWidth((current) =>
      fitSidePanelWidth(
        panelDragRef.current ? current : preferred,
        parent.clientWidth,
        beside,
        rootPx,
      ),
    );
  }, [beside]);

  useLayoutEffect(() => {
    parentRef.current = asideRef.current?.parentElement ?? null;
    clampToParent();
  }, [clampToParent]);

  useResizeObserver({ ref: parentRef, onResize: clampToParent });

  function commitPanelWidth(width: number) {
    panelWidthRef.current = width;
    setPanelWidth(width);
  }

  function currentMaxWidth() {
    const parent = asideRef.current?.parentElement;
    const rootPx = readRootFontSizePx();
    if (!parent) return roundSidePanelRem(window.innerWidth / rootPx / 2);
    return Math.max(MIN_SIDE_PANEL_WIDTH, maxDockedSidePanelWidth(parent.clientWidth, rootPx));
  }

  function onPanelResizePointerDown(event: PointerEvent<HTMLDivElement>) {
    const parent = asideRef.current?.parentElement;
    const isDocked = parent
      ? canDockSidePanel(parent.clientWidth, beside, readRootFontSizePx())
      : docked;
    if (event.button !== 0 || !isDocked) return;
    event.preventDefault();
    panelDragRef.current = { startX: event.clientX, startWidth: panelWidthRef.current };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
  }

  function onPanelResizePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (!drag) return;
    const max = currentMaxWidth();
    const rootPx = readRootFontSizePx();
    const rtl = window.getComputedStyle(event.currentTarget).direction === "rtl";
    const deltaRem = (rtl ? event.clientX - drag.startX : drag.startX - event.clientX) / rootPx;
    const next = roundSidePanelRem(
      Math.min(Math.max(drag.startWidth + deltaRem, MIN_SIDE_PANEL_WIDTH), max),
    );
    commitPanelWidth(next);
  }

  function onPanelResizePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!panelDragRef.current) return;
    panelDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    writeStoredSidePanelWidth(panelWidthRef.current);
  }

  function onPanelResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!docked) return;
    const max = currentMaxWidth();
    const step = event.shiftKey ? 3 : 1;
    const rtl = window.getComputedStyle(event.currentTarget).direction === "rtl";
    const widenKey = rtl ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = rtl ? "ArrowLeft" : "ArrowRight";
    if (event.key === widenKey) {
      event.preventDefault();
      setPanelWidth((current) => {
        const next = roundSidePanelRem(Math.min(current + step, max));
        panelWidthRef.current = next;
        writeStoredSidePanelWidth(next);
        return next;
      });
    } else if (event.key === shrinkKey) {
      event.preventDefault();
      setPanelWidth((current) => {
        const next = roundSidePanelRem(Math.max(current - step, MIN_SIDE_PANEL_WIDTH));
        panelWidthRef.current = next;
        writeStoredSidePanelWidth(next);
        return next;
      });
    }
  }

  const displayWidth = open ? (beside ? `min(100%, ${panelWidth}rem)` : "100%") : 0;

  return {
    asideRef,
    panelWidth,
    displayWidth,
    docked,
    resizeHandle: {
      onPointerDown: onPanelResizePointerDown,
      onPointerMove: onPanelResizePointerMove,
      onPointerUp: onPanelResizePointerUp,
      onPointerCancel: onPanelResizePointerUp,
      onKeyDown: onPanelResizeKeyDown,
    },
  };
}
