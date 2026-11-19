import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSafeZone,
  CASCADE_MENU_TIMINGS,
  getSafeZoneApex,
  isPointInMenuOrBridge,
  isPointInSafeZone,
  type Point,
  pointInRect,
  type PointerTrail,
  pushPointerPoint,
  type RectLike,
  type SafeZoneTriangle,
} from "#src/lib/cascade-menu-safe-zone";
import {
  CascadeDepthContext,
  CascadeMenuContext,
  type CascadeMenuContextValue,
  type CascadeRowState,
} from "#src/components/ui/cascade-menu-context";
import {
  type CascadeDebugTimer,
  type CascadeDebugZoneEntry,
  CascadeMenuDebugOverlay,
} from "#src/components/ui/cascade-menu-debug-overlay";

export {
  CascadeDepthProvider,
  CascadeSubmenuItemProvider,
  CascadeSubmenuPopoverProvider,
  useCascadeDepth,
  useCascadeMenu,
  useCascadeSubmenuItem,
  useCascadeSubmenuPopover,
} from "#src/components/ui/cascade-menu-context";
export type {
  CascadeMenuContextValue,
  CascadeRowState,
  CascadeSubmenuItemContextValue,
  CascadeSubmenuPopoverContextValue,
} from "#src/components/ui/cascade-menu-context";

interface PendingSafeHover {
  readonly depth: number;
  readonly rowId: string;
  readonly submenuId: string | null;
  readonly startedAt: number;
}

function toRectLike(el: HTMLElement): RectLike {
  const rect = el.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export interface CascadeMenuProviderProps {
  readonly isRootOpen: boolean;
  readonly onRequestRootClose: () => void;
  readonly debugSafeZone?: boolean;
  readonly children: ReactNode;
}

export function CascadeMenuProvider({
  isRootOpen,
  onRequestRootClose,
  debugSafeZone = false,
  children,
}: CascadeMenuProviderProps) {
  const [openPath, setOpenPath] = useState<readonly string[]>([]);
  const [hoveredByDepth, setHoveredByDepth] = useState<Readonly<Record<number, string | null>>>({});
  const [skippedByDepth, setSkippedByDepth] = useState<Readonly<Record<number, string | null>>>({});
  const [debugZones, setDebugZones] = useState<readonly CascadeDebugZoneEntry[]>([]);
  const [debugTimer, setDebugTimer] = useState<CascadeDebugTimer | null>(null);

  const anchorElRef = useRef<HTMLElement | null>(null);
  const levelElsRef = useRef<Map<number, HTMLElement>>(new Map());
  const openPathRef = useRef<readonly string[]>(openPath);
  openPathRef.current = openPath;

  const pointerTrailRef = useRef<PointerTrail>({ previous: null, current: null });
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimerRowRef = useRef<{ depth: number; rowId: string } | null>(null);
  const safeWindowIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingSafeHoverRef = useRef<PendingSafeHover | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressRootCloseRef = useRef(false);

  const setTimerBadge = useCallback(
    (next: CascadeDebugTimer | null) => {
      if (debugSafeZone) {
        setDebugTimer(next);
      }
    },
    [debugSafeZone],
  );

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
      openTimerRowRef.current = null;
    }
  }, []);

  const clearSafeWindow = useCallback(() => {
    if (safeWindowIntervalRef.current !== null) {
      clearInterval(safeWindowIntervalRef.current);
      safeWindowIntervalRef.current = null;
    }
    pendingSafeHoverRef.current = null;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const clearAllTimers = useCallback(() => {
    clearOpenTimer();
    clearSafeWindow();
    clearCloseTimer();
    setTimerBadge(null);
  }, [clearCloseTimer, clearOpenTimer, clearSafeWindow, setTimerBadge]);

  useEffect(() => {
    if (!isRootOpen) {
      clearAllTimers();
      setOpenPath([]);
      setHoveredByDepth({});
      setSkippedByDepth({});
      setDebugZones([]);
      pointerTrailRef.current = { previous: null, current: null };
    }
  }, [clearAllTimers, isRootOpen]);

  useEffect(() => () => clearAllTimers(), [clearAllTimers]);

  const registerAnchor = useCallback((el: HTMLElement | null) => {
    anchorElRef.current = el;
  }, []);

  const registerLevel = useCallback((depth: number, el: HTMLElement | null) => {
    if (el) {
      levelElsRef.current.set(depth, el);
    } else {
      levelElsRef.current.delete(depth);
    }
  }, []);

  const commitDepthSelection = useCallback((depth: number, submenuId: string | null) => {
    setOpenPath((prev) => {
      const next = submenuId ? [...prev.slice(0, depth), submenuId] : prev.slice(0, depth);
      if (next.length === prev.length && next.every((id, index) => id === prev[index])) {
        return prev;
      }
      return next;
    });
  }, []);

  const closeAll = useCallback(
    (restoreFocus = false) => {
      clearAllTimers();
      setOpenPath([]);
      setHoveredByDepth({});
      setSkippedByDepth({});
      setDebugZones([]);
      onRequestRootClose();
      if (restoreFocus) {
        anchorElRef.current?.focus();
      }
    },
    [clearAllTimers, onRequestRootClose],
  );

  const openSubmenuNow = useCallback(
    (depth: number, submenuId: string) => {
      clearOpenTimer();
      clearSafeWindow();
      clearCloseTimer();
      setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
      commitDepthSelection(depth, submenuId);
      setTimerBadge(null);
    },
    [clearCloseTimer, clearOpenTimer, clearSafeWindow, commitDepthSelection, setTimerBadge],
  );

  const closeFromDepth = useCallback(
    (depth: number) => {
      clearOpenTimer();
      clearSafeWindow();
      setOpenPath((prev) => prev.slice(0, depth));
      setHoveredByDepth((prev) => {
        const next: Record<number, string | null> = {};
        for (const [key, value] of Object.entries(prev)) {
          const level = Number(key);
          if (level < depth) next[level] = value;
        }
        return next;
      });
      setSkippedByDepth((prev) => {
        const next: Record<number, string | null> = {};
        for (const [key, value] of Object.entries(prev)) {
          const level = Number(key);
          if (level < depth) next[level] = value;
        }
        return next;
      });
      setTimerBadge(null);
    },
    [clearOpenTimer, clearSafeWindow, setTimerBadge],
  );

  const getZoneForDepth = useCallback(
    (
      depth: number,
    ): { parentRect: RectLike; submenuRect: RectLike; zone: SafeZoneTriangle } | null => {
      if (openPathRef.current[depth] === undefined) return null;
      const apex = getSafeZoneApex(pointerTrailRef.current);
      if (!apex) return null;
      const parentEl = levelElsRef.current.get(depth);
      const submenuEl = levelElsRef.current.get(depth + 1);
      if (!parentEl || !submenuEl) return null;
      const parentRect = toRectLike(parentEl);
      const submenuRect = toRectLike(submenuEl);
      const zone = buildSafeZone(apex, parentRect, submenuRect);
      return { parentRect, submenuRect, zone };
    },
    [],
  );

  const onRowPointerEnter = useCallback(
    (depth: number, rowId: string, submenuId: string | null, pointerType: string, point: Point) => {
      clearCloseTimer();
      pointerTrailRef.current = pushPointerPoint(pointerTrailRef.current, point);

      if (pointerType === "touch") {
        clearOpenTimer();
        clearSafeWindow();
        setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
        setHoveredByDepth((prev) => ({ ...prev, [depth]: rowId }));
        commitDepthSelection(depth, submenuId);
        setTimerBadge(null);
        return;
      }

      if (submenuId !== null && openPathRef.current[depth] === submenuId) {
        clearOpenTimer();
        clearSafeWindow();
        setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
        setHoveredByDepth((prev) => ({ ...prev, [depth]: rowId }));
        setTimerBadge(null);
        return;
      }

      const activeZone = getZoneForDepth(depth);
      if (
        activeZone &&
        isPointInSafeZone(point, activeZone.parentRect, activeZone.submenuRect, activeZone.zone)
      ) {
        clearOpenTimer();
        clearSafeWindow();
        setSkippedByDepth((prev) => ({ ...prev, [depth]: rowId }));
        const startedAt = Date.now();
        pendingSafeHoverRef.current = { depth, rowId, submenuId, startedAt };
        setTimerBadge({
          kind: "safe-window",
          startedAt: performance.now(),
          durationMs: CASCADE_MENU_TIMINGS.SAFE_WINDOW_MAX_MS,
        });

        safeWindowIntervalRef.current = setInterval(() => {
          const pending = pendingSafeHoverRef.current;
          if (!pending) {
            clearSafeWindow();
            return;
          }
          const current = pointerTrailRef.current.current;
          const latestZone = getZoneForDepth(pending.depth);
          if (current && latestZone && pointInRect(current, latestZone.submenuRect)) {
            clearSafeWindow();
            setSkippedByDepth((prev) => ({ ...prev, [pending.depth]: null }));
            setTimerBadge(null);
            return;
          }
          const stillInZone =
            current !== null &&
            latestZone !== null &&
            isPointInSafeZone(
              current,
              latestZone.parentRect,
              latestZone.submenuRect,
              latestZone.zone,
            );
          const elapsed = Date.now() - pending.startedAt;
          if (!stillInZone || elapsed >= CASCADE_MENU_TIMINGS.SAFE_WINDOW_MAX_MS) {
            clearSafeWindow();
            setSkippedByDepth((prev) => ({ ...prev, [pending.depth]: null }));
            setHoveredByDepth((prev) => ({ ...prev, [pending.depth]: pending.rowId }));
            commitDepthSelection(pending.depth, pending.submenuId);
            setTimerBadge(null);
          }
        }, CASCADE_MENU_TIMINGS.SAFE_ZONE_RECHECK_MS);
        return;
      }

      clearSafeWindow();
      setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
      setHoveredByDepth((prev) => ({ ...prev, [depth]: rowId }));
      clearOpenTimer();

      const needsChange =
        submenuId !== null
          ? openPathRef.current[depth] !== submenuId
          : openPathRef.current.length > depth;
      if (!needsChange) {
        setTimerBadge(null);
        return;
      }

      openTimerRowRef.current = { depth, rowId };
      setTimerBadge({
        kind: "open",
        startedAt: performance.now(),
        durationMs: CASCADE_MENU_TIMINGS.OPEN_DELAY_MS,
      });
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        openTimerRowRef.current = null;
        commitDepthSelection(depth, submenuId);
        setTimerBadge(null);
      }, CASCADE_MENU_TIMINGS.OPEN_DELAY_MS);
    },
    [
      clearCloseTimer,
      clearOpenTimer,
      clearSafeWindow,
      commitDepthSelection,
      getZoneForDepth,
      setTimerBadge,
    ],
  );

  const onRowPointerLeave = useCallback(
    (depth: number, rowId: string) => {
      if (
        openTimerRowRef.current &&
        openTimerRowRef.current.depth === depth &&
        openTimerRowRef.current.rowId === rowId
      ) {
        clearOpenTimer();
        setTimerBadge(null);
      }
      if (
        pendingSafeHoverRef.current &&
        pendingSafeHoverRef.current.depth === depth &&
        pendingSafeHoverRef.current.rowId === rowId
      ) {
        clearSafeWindow();
        setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
        setTimerBadge(null);
      }
      setHoveredByDepth((prev) => (prev[depth] === rowId ? { ...prev, [depth]: null } : prev));
    },
    [clearOpenTimer, clearSafeWindow, setTimerBadge],
  );

  const onFolderDragEnter = useCallback(
    (depth: number, rowId: string, submenuId: string) => {
      clearCloseTimer();
      clearSafeWindow();
      setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
      setHoveredByDepth((prev) => ({ ...prev, [depth]: rowId }));
      if (openPathRef.current[depth] === submenuId) return;
      clearOpenTimer();
      openTimerRowRef.current = { depth, rowId };
      setTimerBadge({
        kind: "drag-open",
        startedAt: performance.now(),
        durationMs: CASCADE_MENU_TIMINGS.DRAG_OPEN_DELAY_MS,
      });
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        openTimerRowRef.current = null;
        commitDepthSelection(depth, submenuId);
        setTimerBadge(null);
      }, CASCADE_MENU_TIMINGS.DRAG_OPEN_DELAY_MS);
    },
    [clearCloseTimer, clearOpenTimer, clearSafeWindow, commitDepthSelection, setTimerBadge],
  );

  const onFolderDragLeave = useCallback(
    (depth: number, rowId: string) => {
      if (
        openTimerRowRef.current &&
        openTimerRowRef.current.depth === depth &&
        openTimerRowRef.current.rowId === rowId
      ) {
        clearOpenTimer();
        setTimerBadge(null);
      }
      setHoveredByDepth((prev) => (prev[depth] === rowId ? { ...prev, [depth]: null } : prev));
    },
    [clearOpenTimer, setTimerBadge],
  );

  useEffect(() => {
    if (!isRootOpen) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const point: Point = { x: event.clientX, y: event.clientY };
      pointerTrailRef.current = pushPointerPoint(pointerTrailRef.current, point);

      let insideSubmenuDepth = -1;
      for (const [depth, el] of levelElsRef.current.entries()) {
        if (depth >= 1 && pointInRect(point, toRectLike(el))) {
          insideSubmenuDepth = Math.max(insideSubmenuDepth, depth);
        }
      }

      if (insideSubmenuDepth >= 1) {
        if (pendingSafeHoverRef.current && pendingSafeHoverRef.current.depth < insideSubmenuDepth) {
          const clearedDepth = pendingSafeHoverRef.current.depth;
          clearSafeWindow();
          setSkippedByDepth((prev) => ({ ...prev, [clearedDepth]: null }));
          setTimerBadge(null);
        }
      }

      const rects: RectLike[] = [];
      if (anchorElRef.current) {
        rects.push(toRectLike(anchorElRef.current));
      }
      for (const el of levelElsRef.current.values()) {
        rects.push(toRectLike(el));
      }

      const activeZones: SafeZoneTriangle[] = [];
      const nextDebugZones: CascadeDebugZoneEntry[] = [];
      for (let depth = 0; depth < openPathRef.current.length; depth += 1) {
        if (insideSubmenuDepth > depth) continue;
        const entry = getZoneForDepth(depth);
        if (!entry) continue;
        activeZones.push(entry.zone);
        if (debugSafeZone) {
          nextDebugZones.push({
            depth,
            zone: entry.zone,
            parentTop: entry.parentRect.top,
            parentBottom: entry.parentRect.bottom,
          });
        }
      }
      if (debugSafeZone) {
        setDebugZones(nextDebugZones);
      }

      if (isPointInMenuOrBridge(point, rects, activeZones)) {
        if (closeTimerRef.current !== null) {
          clearCloseTimer();
          setTimerBadge(null);
        }
      } else if (closeTimerRef.current === null) {
        setTimerBadge({
          kind: "close",
          startedAt: performance.now(),
          durationMs: CASCADE_MENU_TIMINGS.CLOSE_DELAY_MS,
        });
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null;
          closeAll(false);
        }, CASCADE_MENU_TIMINGS.CLOSE_DELAY_MS);
      }
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    return () => document.removeEventListener("pointermove", handlePointerMove, true);
  }, [
    clearCloseTimer,
    clearSafeWindow,
    closeAll,
    debugSafeZone,
    getZoneForDepth,
    isRootOpen,
    setTimerBadge,
  ]);

  const isSubmenuOpenAt = useCallback(
    (depth: number, submenuId: string) => openPath[depth] === submenuId,
    [openPath],
  );

  const getRowState = useCallback(
    (depth: number, rowId: string, submenuId: string | null): CascadeRowState => {
      if (submenuId !== null && openPath[depth] === submenuId) return "active";
      if (skippedByDepth[depth] === rowId) return "skipped";
      if (hoveredByDepth[depth] === rowId) return "hovered";
      return "idle";
    },
    [hoveredByDepth, openPath, skippedByDepth],
  );

  const markSuppressRootClose = useCallback(() => {
    suppressRootCloseRef.current = true;
    queueMicrotask(() => {
      suppressRootCloseRef.current = false;
    });
  }, []);

  const consumeSuppressRootClose = useCallback(() => {
    if (!suppressRootCloseRef.current) return false;
    suppressRootCloseRef.current = false;
    return true;
  }, []);

  const value = useMemo<CascadeMenuContextValue>(
    () => ({
      isRootOpen,
      openPath,
      isSubmenuOpenAt,
      getRowState,
      registerAnchor,
      registerLevel,
      onRowPointerEnter,
      onRowPointerLeave,
      onFolderDragEnter,
      onFolderDragLeave,
      openSubmenuNow,
      closeFromDepth,
      closeAll,
      markSuppressRootClose,
      consumeSuppressRootClose,
    }),
    [
      closeAll,
      closeFromDepth,
      consumeSuppressRootClose,
      getRowState,
      isRootOpen,
      isSubmenuOpenAt,
      markSuppressRootClose,
      onFolderDragEnter,
      onFolderDragLeave,
      onRowPointerEnter,
      onRowPointerLeave,
      openPath,
      openSubmenuNow,
      registerAnchor,
      registerLevel,
    ],
  );

  return (
    <CascadeMenuContext.Provider value={value}>
      <CascadeDepthContext.Provider value={0}>
        {children}
        {debugSafeZone && isRootOpen && (
          <CascadeMenuDebugOverlay zones={debugZones} timer={debugTimer} />
        )}
      </CascadeDepthContext.Provider>
    </CascadeMenuContext.Provider>
  );
}
