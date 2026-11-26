import {
  createContext,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useHydrated } from "@tanstack/react-router";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
  type PanelSize,
} from "react-resizable-panels";

import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useResizeObserver } from "#src/hooks/use-resize-observer";
import { m } from "#src/paraglide/messages";
import {
  canDockSidePanel,
  DEFAULT_SIDE_PANEL_WIDTH,
  MAIN_COLUMN_MIN_REM,
  MIN_SIDE_PANEL_WIDTH,
  readRootFontSizePx,
} from "./record-side-panel-width";

export const RecordSidePanelDockedContext = createContext(false);

function runSyncing(syncingRef: { current: boolean }, fn: () => void) {
  syncingRef.current = true;
  try {
    fn();
  } finally {
    syncingRef.current = false;
  }
}

export function RecordSplitLayout({
  main,
  side,
  sideOpen,
  onSideOpenChange,
  children,
}: {
  main: ReactNode;
  side: ReactNode;
  sideOpen: boolean;
  onSideOpenChange: (open: boolean) => void;
  children?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sidePanelRef = usePanelRef();
  const syncingRef = useRef(false);
  const hydrated = useHydrated();
  const beside = useBreakpoint("lg");
  const [docked, setDocked] = useState(false);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    setDocked(canDockSidePanel(element.clientWidth, beside, readRootFontSizePx()));
  }, [beside]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useResizeObserver({ ref: containerRef, onResize: measure });

  const dockedSplit = hydrated && docked;
  const splitLayout = useDefaultLayout({
    id: "coforge-records-side-panel",
    panelIds: dockedSplit ? ["main", "side"] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });

  useLayoutEffect(() => {
    if (!dockedSplit) return;
    const panel = sidePanelRef.current;
    if (!panel) return;
    runSyncing(syncingRef, () => {
      if (sideOpen) {
        if (panel.isCollapsed()) panel.expand();
      } else if (!panel.isCollapsed()) {
        panel.collapse();
      }
    });
  }, [dockedSplit, sideOpen, sidePanelRef]);

  const handleSideResize = (
    _size: PanelSize,
    _id: string | number | undefined,
    prev?: PanelSize,
  ) => {
    if (prev === undefined || syncingRef.current) return;
    const panel = sidePanelRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (collapsed === sideOpen) {
      onSideOpenChange(!collapsed);
    }
  };

  const handleLayoutChanged: typeof splitLayout.onLayoutChanged = (nextLayout, meta) => {
    if (sidePanelRef.current?.isCollapsed()) return;
    splitLayout.onLayoutChanged(nextLayout, meta);
  };

  return (
    <div
      ref={containerRef}
      className="@container/record-split relative flex min-h-0 flex-1 overflow-hidden"
    >
      {dockedSplit ? (
        <Group
          id="coforge-records-side-panel"
          orientation="horizontal"
          defaultLayout={splitLayout.defaultLayout}
          onLayoutChanged={handleLayoutChanged}
          resizeTargetMinimumSize={{ coarse: 44, fine: 12 }}
          className="flex min-h-0 min-w-0 flex-1"
        >
          <Panel
            id="main"
            minSize={`${MAIN_COLUMN_MIN_REM}rem`}
            className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-primary"
          >
            {main}
          </Panel>
          {sideOpen ? (
            <Separator
              aria-label={m.controls_resize_sidebar()}
              onDoubleClick={() => sidePanelRef.current?.resize(`${DEFAULT_SIDE_PANEL_WIDTH}rem`)}
              className="w-px shrink-0 bg-border-secondary outline-focus-ring transition-colors hover:bg-brand-solid focus-visible:bg-brand-solid focus-visible:outline-2 data-[separator=active]:bg-brand-solid"
            />
          ) : null}
          <Panel
            id="side"
            panelRef={sidePanelRef}
            defaultSize={sideOpen ? `${DEFAULT_SIDE_PANEL_WIDTH}rem` : "0px"}
            minSize={`${MIN_SIDE_PANEL_WIDTH}rem`}
            maxSize="50%"
            collapsible
            collapsedSize={0}
            onResize={handleSideResize}
            className="flex min-h-0 min-w-0 flex-col"
          >
            <RecordSidePanelDockedContext value={true}>{side}</RecordSidePanelDockedContext>
          </Panel>
        </Group>
      ) : (
        <>
          <div className="relative flex min-w-[min(100%,20rem)] flex-1 flex-col overflow-hidden bg-primary">
            {main}
          </div>
          {side}
        </>
      )}
      {children}
    </div>
  );
}
