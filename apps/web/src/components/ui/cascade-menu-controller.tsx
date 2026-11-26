import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSafeZone,
  CASCADE_MENU_TIMINGS,
  evaluateSafeWindowTick,
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
  measureCascadeLevels,
  toRectLike,
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
  CascadeSubmenuPortalProvider,
  useCascadeDepth,
  useCascadeMenu,
  useCascadeSubmenuItem,
  useCascadeSubmenuPopover,
  useCascadeSubmenuPortal,
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
  const openedByHoverRef = useRef(false);
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
      openedByHoverRef.current = false;
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
      openedByHoverRef.current = false;
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
      openedByHoverRef.current = false;
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
      if (depth === 0) {
        openedByHoverRef.current = false;
      }
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
      measuredRects?: ReadonlyMap<number, RectLike>,
    ): { parentRect: RectLike; submenuRect: RectLike; zone: SafeZoneTriangle } | null => {
      if (openPathRef.current[depth] === undefined) return null;
      const apex = getSafeZoneApex(pointerTrailRef.current);
      if (!apex) return null;
      let parentRect = measuredRects?.get(depth);
      let submenuRect = measuredRects?.get(depth + 1);
      if (!parentRect) {
        const parentEl = levelElsRef.current.get(depth);
        if (!parentEl) return null;
        parentRect = toRectLike(parentEl);
      }
      if (!submenuRect) {
        const submenuEl = levelElsRef.current.get(depth + 1);
        if (!submenuEl) return null;
        submenuRect = toRectLike(submenuEl);
      }
      const zone = buildSafeZone(apex, parentRect, submenuRect);
      return { parentRect, submenuRect, zone };
    },
    [],
  );

  const onRowPointerEnter = useCallback(
    (
      depth: number,
      rowId: string,
      submenuId: string | null,
      pointerType: string,
      point: Point,
      openOnHover = true,
    ) => {
      clearCloseTimer();
      pointerTrailRef.current = pushPointerPoint(pointerTrailRef.current, point);

      if (pointerType === "touch") {
        clearOpenTimer();
        clearSafeWindow();
        openedByHoverRef.current = false;
        setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
        setHoveredByDepth((prev) => ({ ...prev, [depth]: rowId }));
        commitDepthSelection(depth, submenuId);
        setTimerBadge(null);
        return;
      }

      if (submenuId !== null && !openOnHover) {
        clearOpenTimer();
        clearSafeWindow();
        setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
        setHoveredByDepth((prev) => ({ ...prev, [depth]: rowId }));
        setTimerBadge(null);
        return;
      }

      if (submenuId === null && openPathRef.current.length > depth && !openedByHoverRef.current) {
        clearOpenTimer();
        clearSafeWindow();
        setSkippedByDepth((prev) => ({ ...prev, [depth]: null }));
        setHoveredByDepth((prev) => ({ ...prev, [depth]: rowId }));
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
          if (!latestZone) {
            clearSafeWindow();
            setSkippedByDepth((prev) => ({ ...prev, [pending.depth]: null }));
            setTimerBadge(null);
            return;
          }
          const decision = evaluateSafeWindowTick(
            current,
            latestZone.parentRect,
            latestZone.submenuRect,
            latestZone.zone,
            Date.now() - pending.startedAt,
          );
          if (decision === "wait") return;
          clearSafeWindow();
          setSkippedByDepth((prev) => ({ ...prev, [pending.depth]: null }));
          setTimerBadge(null);
          if (decision === "commit") {
            openedByHoverRef.current = pending.submenuId !== null;
            setHoveredByDepth((prev) => ({ ...prev, [pending.depth]: pending.rowId }));
            commitDepthSelection(pending.depth, pending.submenuId);
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
        openedByHoverRef.current = submenuId !== null;
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

  const clearHoverAtDepth = useCallback((depth: number) => {
    setHoveredByDepth((prev) => (prev[depth] ? { ...prev, [depth]: null } : prev));
  }, []);

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
        openedByHoverRef.current = true;
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

      const { measuredLevels, rects, insideSubmenuDepth } = measureCascadeLevels(
        anchorElRef.current,
        levelElsRef.current,
        point,
        pointInRect,
      );

      if (insideSubmenuDepth >= 1) {
        if (pendingSafeHoverRef.current && pendingSafeHoverRef.current.depth < insideSubmenuDepth) {
          const clearedDepth = pendingSafeHoverRef.current.depth;
          clearSafeWindow();
          setSkippedByDepth((prev) => ({ ...prev, [clearedDepth]: null }));
          setTimerBadge(null);
        }
      }

      const activeZones: SafeZoneTriangle[] = [];
      const nextDebugZones: CascadeDebugZoneEntry[] = [];
      for (let depth = 0; depth < openPathRef.current.length; depth += 1) {
        if (insideSubmenuDepth > depth) continue;
        const entry = getZoneForDepth(depth, measuredLevels);
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

      if (openPathRef.current.length === 0 || !openedByHoverRef.current) {
        if (closeTimerRef.current !== null) {
          clearCloseTimer();
          setTimerBadge(null);
        }
        return;
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
          closeFromDepth(0);
        }, CASCADE_MENU_TIMINGS.CLOSE_DELAY_MS);
      }
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    return () => document.removeEventListener("pointermove", handlePointerMove, true);
  }, [
    clearCloseTimer,
    clearSafeWindow,
    closeFromDepth,
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

  const getLevelRect = useCallback((depth: number): RectLike | null => {
    const el = levelElsRef.current.get(depth);
    return el ? toRectLike(el) : null;
  }, []);

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
      getLevelRect,
      registerAnchor,
      registerLevel,
      onRowPointerEnter,
      onRowPointerLeave,
      clearHoverAtDepth,
      onFolderDragEnter,
      onFolderDragLeave,
      openSubmenuNow,
      closeFromDepth,
      closeAll,
      markSuppressRootClose,
      consumeSuppressRootClose,
    }),
    [
      clearHoverAtDepth,
      closeAll,
      closeFromDepth,
      consumeSuppressRootClose,
      getLevelRect,
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
          <CascadeMenuDebugOverlay
            zones={debugZones}
            timer={debugTimer}
            openPathKey={openPath.join("/")}
          />
        )}
      </CascadeDepthContext.Provider>
    </CascadeMenuContext.Provider>
  );
}
