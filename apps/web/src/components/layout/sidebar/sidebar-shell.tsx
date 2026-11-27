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
import {
  SIDEBAR_DEFAULT_REM,
  SIDEBAR_MAX_REM,
  SIDEBAR_MIN_REM,
  clampSidebarWidthRem,
  parseSidebarWidthRem,
  writeSidebarLayoutCookie,
} from "#src/features/settings/sidebar-layout-cookie";
import { m } from "#src/paraglide/messages";

const SIDEBAR_GROUP_ID = "coforge-sidebar";
const SIDEBAR_PANEL_ID = "sidebar";
const MAIN_PANEL_ID = "main";
const SIDEBAR_EXPANDED_WIDTH_KEY = "coforge-sidebar-width";
const SIDEBAR_RAIL_SIZE = "3.5rem";
const SIDEBAR_RESIZE_TARGET = { coarse: 44, fine: 12 };
const SIDEBAR_PANEL_STYLE = { overflow: "hidden" } as const;
const MAIN_PANEL_STYLE = { overflow: "visible" } as const;
const INACTIVE_GROUP_STYLE = { height: "auto", overflow: "visible" } as const;

function rootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

function panelsTotalWidthPx(groupElement: HTMLDivElement | null): number {
  if (!groupElement) return 0;
  let total = 0;
  for (const child of groupElement.children) {
    if (child instanceof HTMLElement && child.hasAttribute("data-panel")) {
      total += child.offsetWidth;
    }
  }
  return total;
}

function readStoredExpandedRem(): number | undefined {
  try {
    return parseSidebarWidthRem(browserLocalStorage()?.getItem(SIDEBAR_EXPANDED_WIDTH_KEY));
  } catch {
    return undefined;
  }
}

function writeRememberedExpandedRem(rem: number) {
  const clamped = clampSidebarWidthRem(rem);
  const rounded = Math.round(clamped * 1000) / 1000;
  writeSidebarLayoutCookie({ widthRem: rounded });
  try {
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
  initialExpanded,
  initialWidthRem,
  showSidebar = true,
  expanded,
  rail,
  children,
}: {
  defaultRail?: boolean;
  initialExpanded?: boolean;
  initialWidthRem?: number;
  showSidebar?: boolean;
  expanded: ReactNode;
  rail: ReactNode;
  children: ReactNode;
}) {
  const groupElementRef = useRef<HTMLDivElement>(null);
  const panelRef = usePanelRef();
  const syncingRef = useRef(false);
  const rememberedRemRef = useRef(initialWidthRem ?? SIDEBAR_DEFAULT_REM);
  const [ready, setReady] = useState(false);

  const [initialSize] = useState(() =>
    (initialExpanded ?? !defaultRail)
      ? `${initialWidthRem ?? SIDEBAR_DEFAULT_REM}rem`
      : SIDEBAR_RAIL_SIZE,
  );

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
    if (!showSidebar) return;
    const storedWidth = readStoredExpandedRem();
    const remembered = storedWidth ?? initialWidthRem ?? SIDEBAR_DEFAULT_REM;
    rememberedRemRef.current = remembered;
    const wantExpanded = isSidebarExpanded();
    const explicitClass =
      document.documentElement.classList.contains("sidebar-expanded") ||
      document.documentElement.classList.contains("sidebar-collapsed");
    if (explicitClass && initialExpanded !== wantExpanded) {
      writeSidebarLayoutCookie({ expanded: wantExpanded });
    }
    if (storedWidth !== undefined && initialWidthRem !== storedWidth) {
      writeSidebarLayoutCookie({ widthRem: storedWidth });
    }
    syncPanelToExpanded(wantExpanded, storedWidth !== undefined && storedWidth !== initialWidthRem);
  }, [showSidebar, defaultRail, initialExpanded, initialWidthRem, syncPanelToExpanded]);

  useEffect(() => {
    if (!showSidebar) return;
    return subscribeSidebarExpanded(syncPanelToExpanded);
  }, [showSidebar, syncPanelToExpanded]);

  useEffect(() => {
    if (!showSidebar) {
      setReady(false);
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [showSidebar]);

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

  const handleLayoutChanged = (nextLayout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const panel = panelRef.current;
    if (!panel || panel.isCollapsed()) return;
    const pct = nextLayout[SIDEBAR_PANEL_ID];
    const groupPx = panelsTotalWidthPx(groupElementRef.current);
    const px = pct !== undefined && groupPx > 0 ? (pct / 100) * groupPx : panel.getSize().inPixels;
    const rem = px / rootFontSizePx();
    if (rem >= SIDEBAR_MIN_REM - 0.1) {
      const clamped = clampSidebarWidthRem(rem);
      rememberedRemRef.current = clamped;
      writeRememberedExpandedRem(clamped);
    }
  };

  const handleSeparatorDoubleClick = () => {
    rememberedRemRef.current = SIDEBAR_DEFAULT_REM;
    writeRememberedExpandedRem(SIDEBAR_DEFAULT_REM);
    if (!isSidebarExpanded()) {
      writeSidebarExpanded(true);
      return;
    }
    panelRef.current?.resize(`${SIDEBAR_DEFAULT_REM}rem`);
  };

  return (
    <Group
      id={SIDEBAR_GROUP_ID}
      elementRef={groupElementRef}
      orientation="horizontal"
      disabled={!showSidebar}
      onLayoutChanged={handleLayoutChanged}
      resizeTargetMinimumSize={SIDEBAR_RESIZE_TARGET}
      data-sidebar-group=""
      data-sidebar-inactive={!showSidebar ? "" : undefined}
      data-ready={showSidebar && ready ? "" : undefined}
      style={showSidebar ? undefined : INACTIVE_GROUP_STYLE}
      className="flex min-h-0 min-w-0 flex-1"
    >
      {showSidebar ? (
        <Panel
          key={SIDEBAR_PANEL_ID}
          id={SIDEBAR_PANEL_ID}
          panelRef={panelRef}
          collapsible
          collapsedSize={SIDEBAR_RAIL_SIZE}
          minSize={`${SIDEBAR_MIN_REM}rem`}
          maxSize={`${SIDEBAR_MAX_REM}rem`}
          defaultSize={initialSize}
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
      ) : null}
      {showSidebar ? (
        <Separator
          key="separator"
          aria-label={m.navigation_resize_sidebar()}
          disableDoubleClick
          onDoubleClick={handleSeparatorDoubleClick}
          data-sidebar-resize-handle=""
          className="relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-transparent outline-hidden"
        />
      ) : null}
      <Panel
        key={MAIN_PANEL_ID}
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
