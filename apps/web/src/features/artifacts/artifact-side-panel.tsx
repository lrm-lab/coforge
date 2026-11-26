import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useHydrated } from "@tanstack/react-router";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";

import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useResizeObserver } from "#src/hooks/use-resize-observer";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { m } from "#src/paraglide/messages";
import { ArtifactMobileSheet } from "./artifact-mobile-sheet";

const DOCK_MIN_REM = 48;
const DEFAULT_SIDE_WIDTH = "21.25rem";

const ArtifactSidePanelDockedContext = createContext(false);

function rootFontSizePx(): number {
  if (typeof window === "undefined") return 16;
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

export function ArtifactSplitLayout({
  canvas,
  side,
  sideOpen,
  markdownFindOpen,
}: {
  canvas: ReactNode;
  side: ReactNode;
  sideOpen: boolean;
  markdownFindOpen: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sidePanelRef = usePanelRef();
  const hydrated = useHydrated();
  const [wideContainer, setWideContainer] = useState(false);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    setWideContainer(element.clientWidth >= DOCK_MIN_REM * rootFontSizePx());
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useResizeObserver({ ref: containerRef, onResize: measure });

  const dockedSplit = hydrated && wideContainer;
  const splitLayout = useDefaultLayout({
    id: "coforge-artifact-side-panel",
    panelIds: dockedSplit && sideOpen ? ["canvas", "side"] : ["canvas"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });

  return (
    <div
      ref={containerRef}
      data-markdown-find-open={markdownFindOpen ? "true" : undefined}
      className="@container/artifact relative flex min-h-0 flex-1"
    >
      {dockedSplit ? (
        <Group
          id="coforge-artifact-side-panel"
          orientation="horizontal"
          defaultLayout={splitLayout.defaultLayout}
          onLayoutChanged={splitLayout.onLayoutChanged}
          resizeTargetMinimumSize={{ coarse: 44, fine: 12 }}
          className="flex min-h-0 min-w-0 flex-1"
        >
          <Panel id="canvas" minSize="40%" className="relative flex min-h-0 min-w-0 flex-col">
            {canvas}
          </Panel>
          {sideOpen ? (
            <>
              <Separator
                aria-label={m.av_resize_side_panel()}
                onDoubleClick={() => sidePanelRef.current?.resize(DEFAULT_SIDE_WIDTH)}
                className="w-px shrink-0 bg-border-secondary outline-focus-ring transition-colors hover:bg-brand-solid focus-visible:bg-brand-solid focus-visible:outline-2 data-[separator=active]:bg-brand-solid"
              />
              <Panel
                id="side"
                panelRef={sidePanelRef}
                defaultSize={DEFAULT_SIDE_WIDTH}
                minSize="18rem"
                maxSize="32rem"
                className="flex min-h-0 min-w-0 flex-col"
              >
                <ArtifactSidePanelDockedContext value={true}>{side}</ArtifactSidePanelDockedContext>
              </Panel>
            </>
          ) : null}
        </Group>
      ) : (
        <>
          {canvas}
          {sideOpen ? side : null}
        </>
      )}
    </div>
  );
}

export function ArtifactSidePanel({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useHotkey("Escape", () => {
    const hasOuterOverlay = [...document.querySelectorAll(OPEN_OVERLAY_SELECTOR)].some(
      (element) => !element.hasAttribute("data-artifact-mobile-sheet"),
    );
    if (hasOuterOverlay) return;
    if (document.querySelector("[data-artifact-find-bar], [data-review-card]")) return;
    onClose();
  });
  const docked = useContext(ArtifactSidePanelDockedContext);
  const wide = useBreakpoint("sm");

  if (docked) {
    return (
      <aside aria-label={label} className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary">
        {children}
      </aside>
    );
  }

  if (!wide) {
    return (
      <ArtifactMobileSheet label={label} onClose={onClose}>
        {children}
      </ArtifactMobileSheet>
    );
  }

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 z-20 hidden bg-overlay/25 sm:block"
      />
      <aside
        aria-label={label}
        className="absolute inset-y-0 end-0 z-30 flex w-[21.25rem] max-w-[min(21.25rem,85vw)] shrink-0 flex-col border-s border-secondary bg-primary shadow-xl"
      >
        {children}
      </aside>
    </>
  );
}
