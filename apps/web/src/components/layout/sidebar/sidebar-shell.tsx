import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  applyListWidth,
  getListWidth,
  setListWidth,
  useListWidth,
} from "#src/features/conversations/conversation-list-layout";
import { SIDEBAR_COLUMN } from "#src/features/conversations/conversation-list-width";
import { isSidebarExpanded, writeSidebarExpanded } from "#src/features/settings/sidebar-expanded";
import {
  SIDEBAR_RAIL_REM,
  beginSidebarDrag,
  finishSidebarDrag,
  keySidebarResize,
  stepSidebarDrag,
} from "./sidebar-resize-model";

const RESTORE_AFTER_COLLAPSE_MS = 180;

function rootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

function isRtlElement(element: HTMLElement): boolean {
  return getComputedStyle(element).direction === "rtl";
}

function measuredWidthRem(shell: HTMLElement | null): number {
  const px = shell?.offsetWidth;
  return px ? px / rootFontSizePx() : getListWidth(SIDEBAR_COLUMN);
}

function SidebarResizeHandle({
  shellRef,
  onLiveDragChange,
}: {
  shellRef: RefObject<HTMLDivElement | null>;
  onLiveDragChange: (live: boolean) => void;
}) {
  const width = useListWidth(SIDEBAR_COLUMN);
  const [dragging, setDragging] = useState(false);
  const [snapPrimed, setSnapPrimed] = useState(false);
  const stopDrag = useRef<AbortController | undefined>(undefined);
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingRestore = useRef<number | undefined>(undefined);

  const flushPendingRestore = () => {
    if (restoreTimer.current !== undefined) {
      clearTimeout(restoreTimer.current);
      restoreTimer.current = undefined;
    }
    if (pendingRestore.current !== undefined) {
      applyListWidth(SIDEBAR_COLUMN, pendingRestore.current);
      pendingRestore.current = undefined;
    }
  };

  useEffect(
    () => () => {
      if (stopDrag.current) {
        stopDrag.current.abort();
        stopDrag.current = undefined;
      }
      flushPendingRestore();
    },
    [],
  );

  useEffect(() => {
    if (!dragging) return;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    flushPendingRestore();
    const handle = event.currentTarget;
    const { pointerId, clientX: startX } = event;
    const remPx = rootFontSizePx();
    const rtl = isRtlElement(handle);
    const collapsed = !isSidebarExpanded();
    const rememberedWidth = getListWidth(SIDEBAR_COLUMN);
    let dragState = beginSidebarDrag({
      collapsed,
      currentWidth: collapsed ? SIDEBAR_RAIL_REM : measuredWidthRem(shellRef.current),
      rememberedWidth,
      startX: startX / remPx,
      rtl,
    });
    try {
      handle.setPointerCapture(pointerId);
    } catch {}
    stopDrag.current?.abort();
    const abort = new AbortController();
    stopDrag.current = abort;
    setDragging(true);
    onLiveDragChange(!collapsed);

    const move = (moved: globalThis.PointerEvent) => {
      if (moved.pointerId !== pointerId) return;
      const step = stepSidebarDrag(dragState, moved.clientX / remPx);
      dragState = step.state;
      setSnapPrimed(step.snapPrimed);
      onLiveDragChange(step.liveResize);
      if (step.collapsedChanged) {
        if (!step.collapsed) {
          applyListWidth(SIDEBAR_COLUMN, step.width);
        }
        writeSidebarExpanded(!step.collapsed);
      } else if (step.liveResize) {
        applyListWidth(SIDEBAR_COLUMN, step.width);
      }
    };

    const end = (ended: globalThis.PointerEvent) => {
      if (ended.pointerId !== pointerId) return;
      abort.abort();
      stopDrag.current = undefined;
      try {
        handle.releasePointerCapture(pointerId);
      } catch {}
      setDragging(false);
      setSnapPrimed(false);
      onLiveDragChange(false);
      const done = finishSidebarDrag(dragState);
      if (done.commitWidth !== undefined) {
        setListWidth(SIDEBAR_COLUMN, done.commitWidth);
      } else if (done.restoreWidth !== undefined) {
        pendingRestore.current = done.restoreWidth;
        restoreTimer.current = setTimeout(() => {
          restoreTimer.current = undefined;
          if (pendingRestore.current !== undefined) {
            applyListWidth(SIDEBAR_COLUMN, pendingRestore.current);
            pendingRestore.current = undefined;
          }
        }, RESTORE_AFTER_COLLAPSE_MS);
      }
    };

    window.addEventListener("pointermove", move, { signal: abort.signal });
    window.addEventListener("pointerup", end, { signal: abort.signal });
    window.addEventListener("pointercancel", end, { signal: abort.signal });
  }

  function onDoubleClick() {
    flushPendingRestore();
    setListWidth(SIDEBAR_COLUMN, SIDEBAR_COLUMN.defaultWidth);
    if (!isSidebarExpanded()) writeSidebarExpanded(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    flushPendingRestore();
    const collapsed = !isSidebarExpanded();
    const rememberedWidth = getListWidth(SIDEBAR_COLUMN);
    const current = collapsed ? SIDEBAR_RAIL_REM : measuredWidthRem(shellRef.current);
    const next = keySidebarResize(event, {
      collapsed,
      width: current,
      rememberedWidth,
      rtl: isRtlElement(event.currentTarget),
    });
    if (!next) return;
    event.preventDefault();
    if (next.collapsed) {
      writeSidebarExpanded(false);
      return;
    }
    setListWidth(SIDEBAR_COLUMN, next.width);
    if (collapsed) writeSidebarExpanded(true);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={SIDEBAR_COLUMN.label()}
      aria-valuenow={Math.round(width * 10) / 10}
      aria-valuemin={SIDEBAR_RAIL_REM}
      aria-valuemax={SIDEBAR_COLUMN.max}
      tabIndex={0}
      data-sidebar-resize-handle=""
      data-dragging={dragging ? "" : undefined}
      data-snap-primed={snapPrimed ? "" : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 end-0 z-10 w-3 cursor-col-resize touch-none outline-hidden pointer-coarse:w-6"
    />
  );
}

export function SidebarShell({
  defaultRail = false,
  expanded,
  rail,
}: {
  defaultRail?: boolean;
  expanded: ReactNode;
  rail: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [liveDrag, setLiveDrag] = useState(false);

  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  return (
    <div
      ref={shellRef}
      data-sidebar-shell=""
      data-default-rail={defaultRail ? "" : undefined}
      data-ready={ready ? "" : undefined}
      data-dragging={liveDrag ? "" : undefined}
      className="relative hidden h-full shrink-0 overflow-hidden lg:block"
    >
      <div
        data-sidebar-panel="expanded"
        className="absolute inset-y-0 start-0 h-full w-(--sidebar-width,15rem)"
      >
        {expanded}
      </div>
      <div data-sidebar-panel="rail" className="absolute inset-y-0 start-0 h-full w-14">
        {rail}
      </div>
      <SidebarResizeHandle shellRef={shellRef} onLiveDragChange={setLiveDrag} />
    </div>
  );
}
