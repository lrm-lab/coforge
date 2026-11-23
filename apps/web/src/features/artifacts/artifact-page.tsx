import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { deleteArtifact } from "./artifacts.functions";
import { ArtifactDeleteConfirm } from "./artifact-delete-confirm";
import { ArtifactFile, ArtifactFileView } from "./artifact-file-view";
import { ArtifactCommentPanel } from "./artifact-comment-panel";
import { ArtifactDraftsProvider } from "./artifact-drafts-provider";
import { ArtifactReviewPill } from "./artifact-review-pill";
import { useReviewFilter } from "./use-review-filter";
import {
  ArtifactCommentingContext,
  CommentPlacesContext,
  CommentRequestsContext,
  ShownThreadsContext,
  type ArtifactCommenting,
  type CommentRequests,
  type PublishedPlaces,
} from "./artifact-commenting";
import { groupThreads } from "./artifact-comment-threads";
import { useArtifactComments } from "./artifact-comment-queries";
import { createComposerHolds } from "./artifact-composer-holds";
import { createArtifactPickBus } from "./artifact-pick-bus";
import { useCommentHandoff } from "./use-comment-handoff";
import { useOpenFile } from "./use-open-file";
import { useShownVersion } from "./use-shown-version";
import { useRevealOnArrival, useThreadReveal } from "./use-thread-reveal";
import { useCommentMode, type ArtifactPanelName } from "./use-comment-mode";
import { ArtifactFilesPanel } from "./artifact-files-panel";
import { ArtifactMarkdown } from "./artifact-markdown";
import type { ArtifactOverlayControls, ArtifactPaneControls } from "./artifact-page-header";
import {
  ArtifactPageHost,
  ArtifactViewerHeader,
  useArtifactDisplayReport,
  useArtifactShellHotkeys,
} from "./artifact-page-shell";
import { homeConversationOf, homeLinkProps, type ArtifactHome } from "./artifact-home";
import { useArtifactLinkSharing } from "./artifact-link-sharing";
import { useKeepSeen, useRecordOpen } from "./artifact-presence-chip";
import { ArtifactSendDialog } from "./artifact-send-dialog";
import { ArtifactUpdateBanner, ViewingVersionNotice } from "./artifact-update-banner";
import { artifactKindOfPath } from "./artifact-path-kind";
import { PaneFrame } from "./artifact-parts";
import { ArtifactUnavailable, LoadingBody, isGone } from "./artifact-page-states";
import { artifactHomeConversation, refreshArtifact } from "./artifact-queries";
import { artifactPageRoute } from "./artifact-search";
import { encodeArtifactShortId, publicArtifactPath } from "./artifact-short-id";
import { ArtifactWebPage } from "./artifact-web-page";
import { useConversationName } from "./use-conversation-name";
import { useArtifactActions } from "./use-artifact-actions";
import { useArtifactPageRealtime } from "./use-artifact-page-realtime";
import { useArtifactVisibility } from "./use-artifact-visibility";
import { useOptionalInlineEmbedPool } from "./inline-embed-pool-context";

type ArtifactPlace = {
  pane?: ArtifactPaneControls;
  overlay?: ArtifactOverlayControls;
  reviewId?: string | undefined;
  commentId?: string | undefined;
  version?: number | undefined;
  arrival?: string | undefined;
  onClearReview?: (() => void) | undefined;
};

const shownEntry = (shown: {
  artifact: { entryPath: string };
  version: { entryPath: string } | null;
}) => shown.version?.entryPath ?? shown.artifact.entryPath;

export function ArtifactPage({
  artifactId,
  pane,
  overlay,
  reviewId,
  commentId,
  version,
  arrival,
  onClearReview,
}: { artifactId: string } & ArtifactPlace) {
  if (!z.uuid().safeParse(artifactId).success)
    return pane ? (
      <PaneFrame full={pane.full} onExit={pane.onToggleFull}>
        <ArtifactUnavailable gone />
      </PaneFrame>
    ) : (
      <ArtifactUnavailable gone onClose={overlay?.onClose} />
    );
  return (
    <ArtifactPageFor
      key={artifactId}
      artifactId={artifactId}
      pane={pane}
      overlay={overlay}
      reviewId={reviewId}
      commentId={commentId}
      version={version}
      arrival={arrival}
      onClearReview={onClearReview}
    />
  );
}

function ArtifactPageFor({
  artifactId,
  pane,
  overlay,
  reviewId,
  commentId,
  version,
  arrival,
  onClearReview,
}: { artifactId: string } & ArtifactPlace) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const router = useRouter();
  const workspaceId = useCurrentWorkspaceId();
  const workspaceSlug = useWorkspaceSlug();
  const embedPool = useOptionalInlineEmbedPool();
  const { read, latest, pinned, pinnedRead, current, shownVersion, pin, unpin } = useShownVersion(
    artifactId,
    version,
    arrival,
  );
  const [incoming, setIncoming] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sendingTo, setSendingTo] = useState(false);
  const [finding, setFinding] = useState(false);
  const [panel, setPanel] = useState<ArtifactPanelName | null>(null);
  const docked = useBreakpoint("sm");
  const commentMode = useCommentMode(setPanel);
  const [places, setPlaces] = useState<PublishedPlaces>(null);
  const [holds] = useState(createComposerHolds);
  const [pickBus] = useState(createArtifactPickBus);
  const openComments = useCallback(() => setPanel("comments"), []);
  const displayReport = useArtifactDisplayReport({ openComments, shownVersion });
  const review = useReviewFilter(artifactId, reviewId, () => onClearReview?.());
  useEffect(() => {
    if (reviewId !== undefined) setPanel("comments");
  }, [reviewId, arrival]);

  const homeKey = current?.artifact.homeKey;
  const homeId = homeKey ? artifactHomeConversation(homeKey) : undefined;
  const home: ArtifactHome | undefined = current && {
    kind: current.artifact.homeKind,
    conversationId: homeId ?? null,
  };
  const link = useArtifactLinkSharing(artifactId, current !== undefined);
  const nameOf = useConversationName();
  const homeConversation = homeConversationOf(home);
  const homeName = homeConversation ? nameOf(homeConversation) : undefined;
  const canChange = current?.artifact.canChange === true;
  const visibility = useArtifactVisibility({
    artifactId,
    tier: current?.artifact.access ?? "conversation",
    link,
    homeName,
    canChange,
    narrowable: current?.artifact.narrowable === true,
  });

  const keepSeen = useKeepSeen(artifactId);

  useArtifactPageRealtime({
    workspaceId,
    artifactId,
    homeId,
    latest,
    queryClient,
    keepSeen,
    onIncomingVersion: setIncoming,
  });

  const opened = useRecordOpen(artifactId, latest);

  const entryPath = current && shownEntry(current);
  const entryKind = entryPath === undefined ? undefined : artifactKindOfPath(entryPath);
  const webPage = entryKind === "html";
  const files = current?.files ?? [];
  const filePaths = useMemo(
    () => (current?.files ?? []).map((file) => file.path),
    [current?.files],
  );
  const commentPanelOpen = panel === "comments" || panel === "pending";
  const locating = panel === "locating";
  const commentsOpen = commentMode.mode || commentPanelOpen || locating;
  const { openPath, source, framesPage, openFile, openThread } = useOpenFile(entryPath, webPage);
  const openMarkdownFile = openPath !== null && artifactKindOfPath(openPath) === "markdown";
  const shownPath = openPath ?? entryPath;
  const startFrameFind = useCallback(() => setFinding(true), []);
  const stopFrameFind = useCallback(() => setFinding(false), []);
  const shell = useArtifactShellHotkeys({
    loaded: current !== undefined,
    framesPage,
    openMarkdownFile,
    showingMarkdown: !openPath && entryKind === "markdown",
    shownVersion,
    openPath,
    finding,
    onStartFrameFind: startFrameFind,
    onStopFrameFind: stopFrameFind,
    panelOpen: panel !== null,
    modalBusy: sendingTo || deleting || visibility.confirming,
    annotating: commentMode.mode,
    overlay,
  });

  const [focus, postFocus, consumeFocus] = useCommentHandoff<string>(() => panel === "comments");
  useEffect(() => {
    if (commentId === undefined) return;
    setPanel("comments");
    postFocus(commentId);
  }, [commentId, arrival, postFocus]);
  const list = useArtifactComments(artifactId, commentsOpen);
  const groups = useMemo(() => groupThreads(list.comments), [list.comments]);
  const publishPlaces = useCallback<ArtifactCommenting["publishPlaces"]>(
    (path, byId) =>
      setPlaces((held) => (byId ? { path, byId } : held?.path === path ? null : held)),
    [],
  );
  const { reveal, consumeReveal, revealThread } = useThreadReveal({
    shown: { latest, pinned, pinFailed: pinnedRead.isError, shownVersion, pin },
    shownPath,
    commentsOpen,
    openFile,
    openThread,
  });
  useRevealOnArrival(commentId, arrival, list.comments, revealThread);
  const shownThreads = useMemo(
    () => groups.anchored.filter(({ root }) => root.version === shownVersion),
    [groups.anchored, shownVersion],
  );
  const commenting = useMemo<ArtifactCommenting>(
    () => ({
      artifactId,
      version: shownVersion,
      entryPath: entryPath ?? "",
      filePaths,
      commenting: commentMode.mode,
      panelOpen: commentPanelOpen || locating,
      revealThread: (target) => {
        if (!docked) setPanel("locating");
        revealThread(target);
      },
      openThread: (commentId) => {
        setPanel("comments");
        postFocus(commentId);
      },
      openPanel: () => setPanel("pending"),
      publishPlaces,
      holds,
      pickBus,
    }),
    [
      artifactId,
      shownVersion,
      entryPath,
      filePaths,
      commentMode.mode,
      commentPanelOpen,
      locating,
      docked,
      revealThread,
      postFocus,
      publishPlaces,
      holds,
      pickBus,
    ],
  );
  const finishReveal = useCallback(() => {
    consumeReveal();
    setPanel((current) => (current === "locating" ? null : current));
  }, [consumeReveal]);
  const requests = useMemo<CommentRequests>(
    () => ({
      reveal,
      consumeReveal: finishReveal,
      focus,
      consumeFocus,
      prefill: displayReport.prefill,
      consumePrefill: displayReport.consumePrefill,
    }),
    [
      reveal,
      finishReveal,
      focus,
      consumeFocus,
      displayReport.prefill,
      displayReport.consumePrefill,
    ],
  );
  const title = current?.artifact.title || m.doc_untitled();
  const copy = async (text: string, done: string) => {
    if (await copyText(text)) toast.success(done);
    else toast.error(m.conversation_copy_failed());
  };
  const copyLink = async () => {
    if (!current) return void toast.error(m.conversation_copy_failed());
    await copy(
      current.artifact.access === "link"
        ? `${window.location.origin}${publicArtifactPath(artifactId)}`
        : `${window.location.origin}${router.buildLocation(artifactPageRoute(workspaceSlug, encodeArtifactShortId(artifactId))).publicHref}`,
      m.doc_link_copied(),
    );
  };
  const backHome = () => {
    if (pane) pane.onClose();
    else if (overlay) overlay.onClose();
    else void router.navigate(homeLinkProps(home, workspaceSlug));
  };
  const viewLatest = () => {
    setIncoming(null);
    unpin();
    openFile(null);
    void refreshArtifact(queryClient, artifactId, homeId ?? null);
  };
  const choose = (version: number) => {
    openFile(null);
    pin(version);
  };
  const { onMoreAction, dialogs, following } = useArtifactActions({
    artifactId,
    homeId: homeId ?? null,
    title,
    shownVersion,
    entryPath: entryPath ?? "",
    body: current?.text,
    files,
    link,
    loaded: current !== undefined,
    actions: {
      find: shell.openFind,
      "copy-link": () => void copyLink(),
      send: () => setSendingTo(true),
      comments: () => setPanel("comments"),
      files: () => setPanel("files"),
      delete: () => setDeleting(true),
    },
  });
  const failure = read.error;
  if (isGone(failure) || (failure && !current)) {
    const unavailable = (
      <ArtifactUnavailable
        gone={isGone(failure)}
        retrying={read.isFetching}
        onRetry={() => void read.refetch()}
        onClose={pane?.onClose ?? overlay?.onClose}
      />
    );
    return pane ? (
      <PaneFrame full={pane.full} onExit={pane.onToggleFull}>
        {unavailable}
      </PaneFrame>
    ) : (
      unavailable
    );
  }
  return (
    <ArtifactPageHost pane={pane} overlay={overlay} hasTitle={current !== undefined}>
      <ArtifactCommentingContext.Provider value={commenting}>
        <ArtifactDraftsProvider enabled={current !== undefined}>
          <ShownThreadsContext.Provider value={shownThreads}>
            <CommentRequestsContext.Provider value={requests}>
              <CommentPlacesContext.Provider value={places}>
                <ArtifactViewerHeader
                  artifactId={artifactId}
                  workspaceId={workspaceId}
                  entryPath={entryPath}
                  title={title}
                  loaded={current !== undefined}
                  shownVersion={shownVersion}
                  latestVersion={latest}
                  commentCount={current?.commentCount}
                  fileCount={files.length}
                  canDelete={current?.canDelete === true}
                  origin={current?.artifact.origin}
                  home={home}
                  homeName={homeName}
                  nameOf={nameOf}
                  visibility={visibility}
                  presenceReady={opened}
                  framesPage={framesPage}
                  annotating={commentMode.mode}
                  commentsPanelActive={panel === "comments"}
                  canFind={shell.canFind}
                  findShortcut={shell.findShortcut}
                  phone={!docked}
                  following={following}
                  pane={pane}
                  overlay={overlay}
                  onChooseVersion={choose}
                  onFind={shell.openFind}
                  onCopyLink={() => void copyLink()}
                  onToggleAnnotate={commentMode.toggleMode}
                  onToggleCommentsPanel={commentMode.togglePanel}
                  onDisplayReport={() => displayReport.trigger()}
                  onMoreAction={onMoreAction}
                />
                <div
                  data-markdown-find-open={
                    shell.markdownFindOpen || (openMarkdownFile && finding) ? "true" : undefined
                  }
                  className="@container/artifact relative flex min-h-0 flex-1"
                >
                  <div
                    ref={displayReport.canvasRef}
                    inert={!docked && (commentPanelOpen || panel === "files")}
                    className="relative flex min-w-0 flex-1 flex-col"
                  >
                    {incoming !== null && incoming > latest && (
                      <ArtifactUpdateBanner
                        artifactId={artifactId}
                        incoming={incoming}
                        onView={viewLatest}
                      />
                    )}
                    {pinned !== null && pinned !== latest && (
                      <ViewingVersionNotice
                        version={pinned}
                        failed={pinnedRead.isError}
                        onBack={unpin}
                      />
                    )}
                    {!current ? (
                      <LoadingBody />
                    ) : openPath ? (
                      <ArtifactFileView
                        artifactId={artifactId}
                        version={shownVersion}
                        title={title}
                        entryPath={shownEntry(current)}
                        path={openPath}
                        source={source}
                        finding={finding}
                        onFindingChange={setFinding}
                        onBack={() => openFile(null)}
                      />
                    ) : webPage ? (
                      <ArtifactWebPage
                        key={shownVersion}
                        artifactId={artifactId}
                        version={shownVersion}
                        title={title}
                        entryPath={shownEntry(current)}
                        path={shownEntry(current)}
                        finding={finding}
                        onFindingChange={setFinding}
                      />
                    ) : entryKind === "markdown" ? (
                      <ArtifactMarkdown
                        path={shownEntry(current)}
                        text={current.text}
                        findOpen={shell.markdownFindOpen}
                        onFindClose={shell.closeMarkdownFind}
                      />
                    ) : (
                      <ArtifactFile
                        artifactId={artifactId}
                        version={shownVersion}
                        path={shownEntry(current)}
                      />
                    )}
                    {current && (
                      <ArtifactReviewPill
                        activePath={shownPath}
                        annotating={commentMode.mode}
                        onToggleAnnotate={commentMode.toggleMode}
                        onExitAnnotate={commentMode.exitMode}
                        onTogglePanel={commentMode.togglePanel}
                      />
                    )}
                  </div>
                  {commentPanelOpen && current && (
                    <ArtifactCommentPanel
                      artifactId={artifactId}
                      shownVersion={shownVersion}
                      pendingReview={panel === "pending"}
                      list={list}
                      groups={groups}
                      review={review}
                      onClose={commentMode.closePanel}
                    />
                  )}
                  {panel === "files" && current && (
                    <ArtifactFilesPanel
                      artifactId={artifactId}
                      version={shownVersion}
                      entryPath={shownEntry(current)}
                      files={files}
                      openPath={openPath}
                      onOpen={openFile}
                      onClose={() => setPanel(null)}
                    />
                  )}
                </div>
                {visibility.dialog}
                {dialogs}
                {sendingTo && (
                  <ArtifactSendDialog
                    artifactId={artifactId}
                    title={title}
                    canChange={canChange}
                    tier={current?.artifact.access ?? "conversation"}
                    linkAvailable={link.available}
                    onClose={() => setSendingTo(false)}
                  />
                )}
                <ArtifactDeleteConfirm
                  open={deleting}
                  onClose={() => setDeleting(false)}
                  title={title}
                  onDelete={async () => {
                    await deleteArtifact({ data: { artifactId } });
                    embedPool?.evictArtifact(artifactId);
                    void refreshArtifact(queryClient, artifactId, homeId ?? null);
                    backHome();
                  }}
                />
              </CommentPlacesContext.Provider>
            </CommentRequestsContext.Provider>
          </ShownThreadsContext.Provider>
        </ArtifactDraftsProvider>
      </ArtifactCommentingContext.Provider>
    </ArtifactPageHost>
  );
}
