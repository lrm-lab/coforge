import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
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

const SIDE_PANEL_WIDTH_CSS_VAR = "--record-side-panel-width";

type PanelDragState = {
  startX: number;
  startWidth: number;
  rootPx: number;
  max: number;
  rtl: boolean;
};

export function useSidePanelWidth(open: boolean) {
  const asideRef = useRef<HTMLElement>(null);
  const parentRef = useRef<HTMLElement | null>(null);
  const panelDragRef = useRef<PanelDragState | null>(null);
  const panelWidthRef = useRef(DEFAULT_SIDE_PANEL_WIDTH);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_SIDE_PANEL_WIDTH);
  const beside = useBreakpoint("lg");
  const [docked, setDocked] = useState(beside);

  const clampToParent = useCallback(() => {
    const parent = asideRef.current?.parentElement ?? null;
    parentRef.current = parent;
    if (!parent) return;
    const rootPx = readRootFontSizePx();
    const parentWidthPx = parent.clientWidth;
    const nextDocked = canDockSidePanel(parentWidthPx, beside, rootPx);
    setDocked(nextDocked);
    const drag = panelDragRef.current;
    if (drag) {
      drag.rootPx = rootPx;
      drag.max = Math.max(MIN_SIDE_PANEL_WIDTH, maxDockedSidePanelWidth(parentWidthPx, rootPx));
      const clamped = fitSidePanelWidth(panelWidthRef.current, parentWidthPx, beside, rootPx);
      panelWidthRef.current = clamped;
      asideRef.current?.style.setProperty(SIDE_PANEL_WIDTH_CSS_VAR, `${clamped}rem`);
      return;
    }
    const preferred = nextDocked ? readStoredSidePanelWidth() : panelWidthRef.current;
    const next = fitSidePanelWidth(preferred, parentWidthPx, beside, rootPx);
    panelWidthRef.current = next;
    setPanelWidth(next);
  }, [beside]);

  useLayoutEffect(() => {
    parentRef.current = asideRef.current?.parentElement ?? null;
    clampToParent();
  }, [clampToParent]);

  useResizeObserver({ ref: parentRef, onResize: clampToParent });

  useEffect(() => {
    return () => {
      if (!panelDragRef.current) return;
      panelDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  function currentMaxWidth(rootPx: number) {
    const parent = asideRef.current?.parentElement;
    if (!parent) return roundSidePanelRem(window.innerWidth / rootPx / 2);
    return Math.max(MIN_SIDE_PANEL_WIDTH, maxDockedSidePanelWidth(parent.clientWidth, rootPx));
  }

  function onPanelResizePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const parent = asideRef.current?.parentElement;
    const rootPx = readRootFontSizePx();
    const isDocked = parent ? canDockSidePanel(parent.clientWidth, beside, rootPx) : docked;
    if (!isDocked) return;
    event.preventDefault();
    const max = parent
      ? Math.max(MIN_SIDE_PANEL_WIDTH, maxDockedSidePanelWidth(parent.clientWidth, rootPx))
      : roundSidePanelRem(window.innerWidth / rootPx / 2);
    const rtl = window.getComputedStyle(event.currentTarget).direction === "rtl";
    panelDragRef.current = {
      startX: event.clientX,
      startWidth: panelWidthRef.current,
      rootPx,
      max,
      rtl,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
  }

  function onPanelResizePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (!drag) return;
    const deltaRem =
      (drag.rtl ? event.clientX - drag.startX : drag.startX - event.clientX) / drag.rootPx;
    const next = roundSidePanelRem(
      Math.min(Math.max(drag.startWidth + deltaRem, MIN_SIDE_PANEL_WIDTH), drag.max),
    );
    if (next === panelWidthRef.current) return;
    panelWidthRef.current = next;
    asideRef.current?.style.setProperty(SIDE_PANEL_WIDTH_CSS_VAR, `${next}rem`);
    event.currentTarget.setAttribute("aria-valuenow", String(Math.round(next * 10) / 10));
  }

  function onPanelResizePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!panelDragRef.current) return;
    panelDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const committed = panelWidthRef.current;
    setPanelWidth(committed);
    writeStoredSidePanelWidth(committed);
  }

  function onPanelResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!docked) return;
    const rtl = window.getComputedStyle(event.currentTarget).direction === "rtl";
    const widenKey = rtl ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = rtl ? "ArrowLeft" : "ArrowRight";
    if (event.key !== widenKey && event.key !== shrinkKey) return;
    event.preventDefault();
    const max = currentMaxWidth(readRootFontSizePx());
    const step = event.shiftKey ? 3 : 1;
    const next =
      event.key === widenKey
        ? roundSidePanelRem(Math.min(panelWidthRef.current + step, max))
        : roundSidePanelRem(Math.max(panelWidthRef.current - step, MIN_SIDE_PANEL_WIDTH));
    panelWidthRef.current = next;
    asideRef.current?.style.setProperty(SIDE_PANEL_WIDTH_CSS_VAR, `${next}rem`);
    setPanelWidth(next);
    writeStoredSidePanelWidth(next);
  }

  const asideStyle = (
    open
      ? {
          [SIDE_PANEL_WIDTH_CSS_VAR]: `${panelWidth}rem`,
          width: beside ? `min(100%, var(${SIDE_PANEL_WIDTH_CSS_VAR}))` : "100%",
        }
      : { width: 0 }
  ) as CSSProperties;
  const contentMinWidth = open ? `min(100%, var(${SIDE_PANEL_WIDTH_CSS_VAR}))` : 0;

  return {
    asideRef,
    panelWidth,
    asideStyle,
    contentMinWidth,
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
