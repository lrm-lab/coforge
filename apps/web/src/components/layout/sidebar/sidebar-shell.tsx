import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Group,
  Panel,
  Separator,
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
  type PanelSize,
} from "react-resizable-panels";
import { browserLocalStorage } from "#src/features/browser-local-storage";
import {
  isSidebarExpanded,
  subscribeSidebarExpanded,
  writeSidebarExpanded,
} from "#src/features/settings/sidebar-expanded";
import { m } from "#src/paraglide/messages";

const SIDEBAR_GROUP_ID = "coforge-sidebar";
const SIDEBAR_PANEL_ID = "sidebar";
const MAIN_PANEL_ID = "main";
const SIDEBAR_EXPANDED_WIDTH_KEY = "coforge-sidebar-width";
const SIDEBAR_DEFAULT_REM = 15;
const SIDEBAR_MIN_REM = 10;
const SIDEBAR_MAX_REM = 20;
const SIDEBAR_RAIL_SIZE = "3.5rem";
const SIDEBAR_RESIZE_TARGET = { coarse: 44, fine: 12 };
const SIDEBAR_PANEL_STYLE = { overflow: "hidden" } as const;
const MAIN_PANEL_STYLE = { overflow: "visible" } as const;
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

function rootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

function readRememberedExpandedRem(): number {
  try {
    const raw = browserLocalStorage()?.getItem(SIDEBAR_EXPANDED_WIDTH_KEY) ?? null;
    if (raw === null || !PLAIN_NUMBER.test(raw)) return SIDEBAR_DEFAULT_REM;
    const parsed = Number(raw);
    const rem = parsed > 80 ? parsed / 16 : parsed;
    return Math.min(SIDEBAR_MAX_REM, Math.max(SIDEBAR_MIN_REM, rem));
  } catch {
    return SIDEBAR_DEFAULT_REM;
  }
}

function writeRememberedExpandedRem(rem: number) {
  try {
    const clamped = Math.min(SIDEBAR_MAX_REM, Math.max(SIDEBAR_MIN_REM, rem));
    const rounded = Math.round(clamped * 1000) / 1000;
    browserLocalStorage()?.setItem(SIDEBAR_EXPANDED_WIDTH_KEY, String(rounded));
  } catch {}
}

function runSyncing(syncingRef: { current: boolean }, fn: () => void) {
  syncingRef.current = true;
  try {
    fn();
  } finally {
    syncingRef.current = false;
  }
}

export function SidebarShell({
  defaultRail = false,
  expanded,
  rail,
  children,
}: {
  defaultRail?: boolean;
  expanded: ReactNode;
  rail: ReactNode;
  children: ReactNode;
}) {
  const panelRef = usePanelRef();
  const syncingRef = useRef(false);
  const rememberedRemRef = useRef(SIDEBAR_DEFAULT_REM);
  const [ready, setReady] = useState(false);

  const syncPanelToExpanded = useCallback(
    (wantExpanded: boolean, applyRememberedWidth = false) => {
      const panel = panelRef.current;
      if (!panel) return;
      runSyncing(syncingRef, () => {
        if (wantExpanded) {
          if (panel.isCollapsed() || applyRememberedWidth) {
            panel.resize(`${rememberedRemRef.current}rem`);
          }
        } else if (!panel.isCollapsed()) {
          panel.collapse();
        }
      });
    },
    [panelRef],
  );

  useLayoutEffect(() => {
    const remembered = readRememberedExpandedRem();
    rememberedRemRef.current = remembered;
    syncPanelToExpanded(isSidebarExpanded(), remembered !== SIDEBAR_DEFAULT_REM);
  }, [defaultRail, syncPanelToExpanded]);

  useEffect(() => subscribeSidebarExpanded(syncPanelToExpanded), [syncPanelToExpanded]);

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

  const handleResize = (_size: PanelSize, _id: string | number | undefined, prev?: PanelSize) => {
    if (prev === undefined || syncingRef.current) return;
    const panel = panelRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (collapsed !== !isSidebarExpanded()) {
      runSyncing(syncingRef, () => {
        writeSidebarExpanded(!collapsed);
      });
    }
  };

  const handleLayoutChanged = (_nextLayout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const panel = panelRef.current;
    if (!panel || panel.isCollapsed()) return;
    const rem = panel.getSize().inPixels / rootFontSizePx();
    if (rem >= SIDEBAR_MIN_REM - 0.1) {
      const clamped = Math.min(SIDEBAR_MAX_REM, Math.max(SIDEBAR_MIN_REM, rem));
      rememberedRemRef.current = clamped;
      writeRememberedExpandedRem(clamped);
    }
  };

  const handleSeparatorDoubleClick = () => {
    rememberedRemRef.current = SIDEBAR_DEFAULT_REM;
    writeRememberedExpandedRem(SIDEBAR_DEFAULT_REM);
  };

  return (
    <Group
      id={SIDEBAR_GROUP_ID}
      orientation="horizontal"
      onLayoutChanged={handleLayoutChanged}
      resizeTargetMinimumSize={SIDEBAR_RESIZE_TARGET}
      data-sidebar-group=""
      data-ready={ready ? "" : undefined}
      className="flex min-h-0 min-w-0 flex-1"
    >
      <Panel
        id={SIDEBAR_PANEL_ID}
        panelRef={panelRef}
        collapsible
        collapsedSize={SIDEBAR_RAIL_SIZE}
        minSize={`${SIDEBAR_MIN_REM}rem`}
        maxSize={`${SIDEBAR_MAX_REM}rem`}
        defaultSize={`${SIDEBAR_DEFAULT_REM}rem`}
        groupResizeBehavior="preserve-pixel-size"
        onResize={handleResize}
        data-sidebar-shell=""
        data-default-rail={defaultRail ? "" : undefined}
        style={SIDEBAR_PANEL_STYLE}
        className="relative h-full"
      >
        <div
          data-sidebar-panel="expanded"
          className="absolute inset-y-0 start-0 h-full w-full min-w-40"
        >
          {expanded}
        </div>
        <div data-sidebar-panel="rail" className="absolute inset-y-0 start-0 h-full w-14">
          {rail}
        </div>
      </Panel>
      <Separator
        aria-label={m.navigation_resize_sidebar()}
        onDoubleClick={handleSeparatorDoubleClick}
        data-sidebar-resize-handle=""
        className="relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-transparent outline-hidden"
      />
      <Panel
        id={MAIN_PANEL_ID}
        groupResizeBehavior="preserve-relative-size"
        style={MAIN_PANEL_STYLE}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {children}
      </Panel>
    </Group>
  );
}
