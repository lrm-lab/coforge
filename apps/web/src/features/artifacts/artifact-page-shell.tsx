import type { ReactNode } from "react";

import { m } from "#src/paraglide/messages";
import { ArtifactCommentButton } from "./artifact-comment-button";
import type { ArtifactHome } from "./artifact-home";
import { ArtifactHomeChip } from "./artifact-home-chip";
import { ArtifactMoreMenu, type MoreAction } from "./artifact-more-menu";
import { ArtifactOriginLink } from "./artifact-origin-link";
import {
  ARTIFACT_TITLE_ID,
  ArtifactPageHeader,
  type ArtifactPaneControls,
} from "./artifact-page-header";
import { PaneFrame } from "./artifact-parts";
import { ArtifactPresenceChip } from "./artifact-presence-chip";
import type { ArtifactDocument } from "./artifact-queries";
import { VisibilityPill } from "./artifact-visibility-pill";
import type { ArtifactVisibility } from "./use-artifact-visibility";

export function ArtifactViewerHeader({
  artifactId,
  workspaceId,
  entryPath,
  title,
  loaded,
  shownVersion,
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
  commentsPanelActive,
  phone,
  following,
  pane,
  onChooseVersion,
  onFind,
  onCopyLink,
  onToggleCommentsPanel,
  onMoreAction,
}: {
  artifactId: string;
  workspaceId: string | undefined;
  entryPath: string | undefined;
  title: string;
  loaded: boolean;
  shownVersion: number;
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
  commentsPanelActive: boolean;
  phone: boolean;
  following: boolean;
  pane?: ArtifactPaneControls;
  onChooseVersion: (version: number) => void;
  onFind: () => void;
  onCopyLink: () => void;
  onToggleCommentsPanel: () => void;
  onMoreAction: (action: MoreAction) => void;
}) {
  return (
    <ArtifactPageHeader
      artifactId={artifactId}
      entryPath={entryPath}
      title={title}
      shownVersion={loaded ? shownVersion : undefined}
      home={home}
      homeName={homeName}
      pane={pane}
      onChooseVersion={onChooseVersion}
      onFind={framesPage ? onFind : undefined}
      onCopyLink={loaded ? onCopyLink : undefined}
      comments={
        loaded && (
          <ArtifactCommentButton
            total={commentCount}
            active={commentsPanelActive}
            onToggle={onToggleCommentsPanel}
          />
        )
      }
      pills={
        loaded && (
          <>
            <VisibilityPill visibility={visibility} />
            {home && (
              <span className="contents @max-2xl/header:hidden">
                <ArtifactHomeChip home={home} homeName={homeName} scope={visibility.current} />
              </span>
            )}
            <ArtifactOriginLink origin={origin} nameOf={nameOf} />
            <span className="contents @max-2xl/header:hidden">
              <ArtifactPresenceChip
                workspaceId={workspaceId}
                artifactId={artifactId}
                ready={presenceReady}
              />
            </span>
          </>
        )
      }
      menu={
        loaded && (
          <ArtifactMoreMenu
            artifactId={artifactId}
            shownVersion={shownVersion}
            phone={phone}
            fileCount={fileCount}
            canDelete={canDelete}
            canFind={framesPage}
            following={following}
            visibility={visibility}
            onChooseVersion={onChooseVersion}
            onAction={onMoreAction}
          />
        )
      }
    />
  );
}

export function ArtifactPageHost({
  pane,
  hasTitle,
  children,
}: {
  pane?: ArtifactPaneControls;
  hasTitle: boolean;
  children: ReactNode;
}) {
  return pane ? (
    <PaneFrame full={pane.full} onExit={pane.onToggleFull}>
      {children}
    </PaneFrame>
  ) : (
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
