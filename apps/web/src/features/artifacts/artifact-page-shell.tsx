import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

import { hotkeyLabel } from "#src/lib/hotkeys";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { isApplePlatform } from "#src/lib/platform";
import { m } from "#src/paraglide/messages";
import type { DisplayReportRequest } from "./artifact-commenting";
import { ArtifactDetailsPopover } from "./artifact-details-popover";
import { useDisplayReportPrefill } from "./artifact-display-report";
import { ArtifactHeaderComments } from "./artifact-header-comments";
import type { ArtifactHome } from "./artifact-home";
import { ArtifactMoreMenu, type MoreAction } from "./artifact-more-menu";
import {
  ARTIFACT_TITLE_ID,
  ArtifactPageHeader,
  type ArtifactOverlayControls,
  type ArtifactPaneControls,
} from "./artifact-page-header";
import { PaneFrame } from "./artifact-parts";
import { ArtifactPresenceChip } from "./artifact-presence-chip";
import type { ArtifactDocument } from "./artifact-queries";
import { VisibilityPill } from "./artifact-visibility-pill";
import type { ArtifactVisibility } from "./use-artifact-visibility";

export function measureArtifactCanvas(container: HTMLElement | null): {
  width?: number;
  height?: number;
} {
  if (!container) return {};
  const target = container.querySelector("iframe") ?? container;
  const rect = target.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0
    ? { width: Math.round(rect.width), height: Math.round(rect.height) }
    : {};
}

export function useArtifactDisplayReport({
  openComments,
  shownVersion,
}: {
  openComments: () => void;
  shownVersion: number;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const { prefill, consumePrefill, requestDisplayReport } = useDisplayReportPrefill(
    openComments,
    shownVersion,
  );
  const trigger = useCallback(
    (input?: DisplayReportRequest) =>
      requestDisplayReport({ ...measureArtifactCanvas(canvasRef.current), ...input }),
    [requestDisplayReport],
  );
  return {
    canvasRef,
    prefill,
    consumePrefill,
    trigger,
  };
}

export function useArtifactShellHotkeys({
  loaded,
  framesPage,
  openMarkdownFile,
  showingMarkdown,
  shownVersion,
  openPath,
  finding,
  onStartFrameFind,
  onStopFrameFind,
  panelOpen,
  modalBusy,
  annotating,
  overlay,
}: {
  loaded: boolean;
  framesPage: boolean;
  openMarkdownFile: boolean;
  showingMarkdown: boolean;
  shownVersion: number;
  openPath: string | null;
  finding: boolean;
  onStartFrameFind: () => void;
  onStopFrameFind: () => void;
  panelOpen: boolean;
  modalBusy: boolean;
  annotating: boolean;
  overlay?: ArtifactOverlayControls;
}) {
  const [markdownFindOpen, setMarkdownFindOpen] = useState(false);
  const [apple, setApple] = useState(false);

  useEffect(() => {
    setApple(isApplePlatform());
  }, []);

  useEffect(() => {
    setMarkdownFindOpen(false);
    onStopFrameFind();
  }, [shownVersion, openPath, onStopFrameFind]);

  const canFind = framesPage || openMarkdownFile || showingMarkdown;

  const openFind = useCallback(() => {
    if (framesPage || openMarkdownFile) onStartFrameFind();
    else if (showingMarkdown) setMarkdownFindOpen(true);
  }, [framesPage, openMarkdownFile, onStartFrameFind, showingMarkdown]);

  const closeMarkdownFind = useCallback(() => setMarkdownFindOpen(false), []);

  useHotkey("Mod+F", () => openFind(), {
    enabled: loaded && canFind && !modalBusy,
    preventDefault: true,
    ignoreInputs: false,
  });

  useHotkey(
    "Escape",
    () => {
      if (document.querySelector(OPEN_OVERLAY_SELECTOR)) return;
      if (markdownFindOpen) setMarkdownFindOpen(false);
      else if (finding) onStopFrameFind();
    },
    {
      enabled: markdownFindOpen || finding,
    },
  );

  useHotkey(
    "Escape",
    () => {
      if (document.querySelector(OPEN_OVERLAY_SELECTOR)) return;
      if (document.querySelector("[data-review-card], [data-artifact-find-bar]")) return;
      overlay?.onClose();
    },
    {
      enabled:
        Boolean(overlay) &&
        !panelOpen &&
        !finding &&
        !markdownFindOpen &&
        !modalBusy &&
        !annotating,
    },
  );

  return {
    canFind,
    openFind,
    markdownFindOpen,
    closeMarkdownFind,
    findShortcut: hotkeyLabel("Mod+F", apple),
  };
}

export function ArtifactViewerHeader({
  artifactId,
  workspaceId,
  entryPath,
  title,
  loaded,
  shownVersion,
  latestVersion,
  commentCount,
  fileCount,
  canDelete,
  origin,
  home,
  homeName,
  nameOf,
  visibility,
  presenceReady,
  framesPage,
  annotating,
  commentsPanelActive,
  canFind,
  findShortcut,
  phone,
  following,
  pane,
  overlay,
  onChooseVersion,
  onFind,
  onCopyLink,
  onToggleAnnotate,
  onToggleCommentsPanel,
  onDisplayReport,
  onMoreAction,
}: {
  artifactId: string;
  workspaceId: string | undefined;
  entryPath: string | undefined;
  title: string;
  loaded: boolean;
  shownVersion: number;
  latestVersion: number;
  commentCount: number | undefined;
  fileCount: number;
  canDelete: boolean;
  origin: ArtifactDocument["artifact"]["origin"] | undefined;
  home: ArtifactHome | undefined;
  homeName: string | undefined;
  nameOf: (conversationId: string) => string | undefined;
  visibility: ArtifactVisibility;
  presenceReady: boolean;
  framesPage: boolean;
  annotating: boolean;
  commentsPanelActive: boolean;
  canFind: boolean;
  findShortcut: string;
  phone: boolean;
  following: boolean;
  pane?: ArtifactPaneControls;
  overlay?: ArtifactOverlayControls;
  onChooseVersion: (version: number) => void;
  onFind: () => void;
  onCopyLink: () => void;
  onToggleAnnotate: () => void;
  onToggleCommentsPanel: () => void;
  onDisplayReport: () => void;
  onMoreAction: (action: MoreAction) => void;
}) {
  const standalone = !pane && !overlay;
  const hasRecentSwitcher = Boolean(pane?.conversationId && pane.onSwitchArtifact);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const titleContainerRef = useRef<HTMLDivElement>(null);
  const detailsProps = loaded
    ? {
        artifactId,
        workspaceId,
        title,
        titleId: ARTIFACT_TITLE_ID,
        titleAs: (standalone ? "h1" : "h2") as "h1" | "h2",
        shownVersion,
        latestVersion,
        visibility,
        home,
        homeName,
        origin,
        nameOf,
        presenceReady,
        onChooseVersion,
      }
    : undefined;

  return (
    <>
      <ArtifactPageHeader
        artifactId={artifactId}
        entryPath={entryPath}
        title={title}
        shownVersion={loaded ? shownVersion : undefined}
        home={home}
        homeName={homeName}
        pane={pane}
        overlay={overlay}
        titleContainerRef={titleContainerRef}
        onChooseVersion={onChooseVersion}
        onFind={loaded && canFind ? onFind : undefined}
        findShortcut={findShortcut}
        onCopyLink={loaded && standalone ? onCopyLink : undefined}
        detailsTrigger={detailsProps && <ArtifactDetailsPopover {...detailsProps} />}
        comments={
          loaded && (
            <ArtifactHeaderComments
              html={framesPage}
              total={commentCount}
              annotating={annotating}
              panelActive={commentsPanelActive}
              onToggleAnnotate={onToggleAnnotate}
              onTogglePanel={onToggleCommentsPanel}
              onDisplayReport={onDisplayReport}
            />
          )
        }
        mobileMeta={
          loaded && (
            <>
              <VisibilityPill visibility={visibility} />
              <ArtifactPresenceChip
                workspaceId={workspaceId}
                artifactId={artifactId}
                ready={presenceReady}
              />
            </>
          )
        }
        menu={
          loaded && (
            <ArtifactMoreMenu
              artifactId={artifactId}
              shownVersion={shownVersion}
              phone={phone}
              showCopyLink={phone || !standalone}
              showDisplayReport={!framesPage}
              fileCount={fileCount}
              canDelete={canDelete}
              canFind={canFind}
              following={following}
              visibility={visibility}
              onChooseVersion={onChooseVersion}
              onOpenDetails={hasRecentSwitcher ? () => setDetailsOpen(true) : undefined}
              onDisplayReport={onDisplayReport}
              onAction={onMoreAction}
            />
          )
        }
      />
      {hasRecentSwitcher && detailsProps && (
        <ArtifactDetailsPopover
          {...detailsProps}
          isOpen={detailsOpen}
          onOpenChange={setDetailsOpen}
          triggerRef={titleContainerRef}
        />
      )}
    </>
  );
}

export function ArtifactPageHost({
  pane,
  overlay,
  hasTitle,
  children,
}: {
  pane?: ArtifactPaneControls;
  overlay?: ArtifactOverlayControls;
  hasTitle: boolean;
  children: ReactNode;
}) {
  if (pane) {
    return (
      <PaneFrame full={pane.full} onExit={pane.onToggleFull}>
        {children}
      </PaneFrame>
    );
  }
  if (overlay) {
    return (
      <section
        data-artifact-overlay=""
        aria-labelledby={hasTitle ? ARTIFACT_TITLE_ID : undefined}
        aria-label={hasTitle ? undefined : m.doc_pane_label()}
        className="@container/doc flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary animate-in fade-in motion-enter-sm motion-reduce:animate-none"
      >
        {children}
      </section>
    );
  }
  return (
    <main
      data-artifact-page-frame=""
      aria-labelledby={hasTitle ? ARTIFACT_TITLE_ID : undefined}
      aria-label={hasTitle ? undefined : m.doc_pane_label()}
      className="@container/doc flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary lg:animate-in lg:fade-in lg:motion-enter-sm motion-reduce:animate-none"
    >
      {children}
    </main>
  );
}
