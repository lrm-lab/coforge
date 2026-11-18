import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { deleteArtifact } from "./artifacts.functions";
import { ArtifactDeleteConfirm } from "./artifact-delete-confirm";
import { ArtifactFile, ArtifactFileView } from "./artifact-file-view";
import { ArtifactCommentButton } from "./artifact-comment-button";
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
import { useArtifactComments, syncCommentsChange } from "./artifact-comment-queries";
import { createComposerHolds } from "./artifact-composer-holds";
import { useCommentHandoff } from "./use-comment-handoff";
import { useOpenFile } from "./use-open-file";
import { useShownVersion } from "./use-shown-version";
import { useRevealOnArrival, useThreadReveal } from "./use-thread-reveal";
import { useCommentMode, type ArtifactPanelName } from "./use-comment-mode";
import { ArtifactFilesPanel } from "./artifact-files-panel";
import { ArtifactMarkdown } from "./artifact-markdown";
import { ArtifactMoreMenu } from "./artifact-more-menu";
import {
  ARTIFACT_TITLE_ID,
  ArtifactPageHeader,
  type ArtifactPaneControls,
} from "./artifact-page-header";
import { homeConversationOf, homeLinkProps, type ArtifactHome } from "./artifact-home";
import { useArtifactLinkSharing } from "./artifact-link-sharing";
import { ArtifactHomeChip } from "./artifact-home-chip";
import { ArtifactPresenceChip, useKeepSeen, useRecordOpen } from "./artifact-presence-chip";
import { ArtifactSendDialog } from "./artifact-send-dialog";
import { ArtifactUpdateBanner, ViewingVersionNotice } from "./artifact-update-banner";
import { artifactKindOfPath } from "./artifact-path-kind";
import { PaneFrame } from "./artifact-parts";
import { ArtifactUnavailable, LoadingBody, isGone } from "./artifact-page-states";
import { artifactHomeConversation, refreshArtifact } from "./artifact-queries";
import {
  decodeArtifactAccessChangedEvent,
  decodeArtifactCommentsChangedEvent,
  decodeArtifactDataChangedEvent,
  decodeArtifactVersionPublishedEvent,
} from "./artifact-realtime";
import { artifactPageRoute } from "./artifact-search";
import { artifactDataEvents } from "./artifact-page-data-events";
import { ArtifactWebPage } from "./artifact-web-page";
import { VisibilityPill } from "./artifact-visibility-pill";
import { useConversationName } from "./use-conversation-name";
import { useArtifactActions } from "./use-artifact-actions";
import { useArtifactVisibility } from "./use-artifact-visibility";

type ArtifactPlace = {
  pane?: ArtifactPaneControls;
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
  reviewId,
  commentId,
  version,
  arrival,
  onClearReview,
}: { artifactId: string } & ArtifactPlace) {
  if (!z.uuid().safeParse(artifactId).success)
    return pane ? (
      <PaneFrame full={pane.full}>
        <ArtifactUnavailable gone />
      </PaneFrame>
    ) : (
      <ArtifactUnavailable gone />
    );
  return (
    <ArtifactPageFor
      key={artifactId}
      artifactId={artifactId}
      pane={pane}
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
  const commentMode = useCommentMode(setPanel);
  const [places, setPlaces] = useState<PublishedPlaces>(null);
  const [holds] = useState(createComposerHolds);
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

  useRealtimeSubscription({
    channel:
      homeId === undefined || !workspaceId
        ? undefined
        : homeId
          ? conversationRealtimeChannel(homeId)
          : workspaceConversationChannel(workspaceId),
    recoverable: true,
    positioned: true,
    onPublication: ({ data }) => {
      const commentsChange = decodeArtifactCommentsChangedEvent(data);
      if (commentsChange) {
        if (commentsChange.artifactId === artifactId) {
          void syncCommentsChange(queryClient, commentsChange);
          keepSeen();
        }
        return;
      }
      const dataChange = decodeArtifactDataChangedEvent(data);
      if (dataChange) {
        if (dataChange.artifactId === artifactId) artifactDataEvents.emit(dataChange);
        return;
      }
      const published = decodeArtifactVersionPublishedEvent(data);
      if (published?.artifactId === artifactId) {
        if (published.number > latest) setIncoming(published.number);
        keepSeen();
        void refreshArtifact(queryClient, artifactId, homeId ?? null, { document: false });
        return;
      }
      if (decodeArtifactAccessChangedEvent(data)?.artifactId === artifactId)
        void refreshArtifact(queryClient, artifactId, homeId ?? null);
    },
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
  const commentsOpen = commentMode.mode || panel === "comments";
  const { openPath, source, framesPage, openFile, openThread } = useOpenFile(entryPath, webPage);
  const shownPath = openPath ?? entryPath;
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
      panelOpen: panel === "comments",
      revealThread,
      openThread: (commentId) => {
        setPanel("comments");
        postFocus(commentId);
      },
      openPanel: () => setPanel("comments"),
      publishPlaces,
      holds,
    }),
    [
      artifactId,
      shownVersion,
      entryPath,
      filePaths,
      commentMode.mode,
      panel,
      revealThread,
      postFocus,
      publishPlaces,
      holds,
    ],
  );
  const requests = useMemo<CommentRequests>(
    () => ({ reveal, consumeReveal, focus, consumeFocus }),
    [reveal, consumeReveal, focus, consumeFocus],
  );
  const title = current?.artifact.title || m.doc_untitled();
  const copy = async (text: string, done: string) => {
    if (await copyText(text)) toast.success(done);
    else toast.error(m.conversation_copy_failed());
  };
  const copyLink = async () => {
    const shared = await link.current().catch(() => undefined);
    if (shared === undefined) return void toast.error(m.conversation_copy_failed());
    await copy(
      shared ??
        `${window.location.origin}${router.buildLocation(artifactPageRoute(workspaceSlug, artifactId)).publicHref}`,
      m.doc_link_copied(),
    );
  };
  const backHome = () => {
    if (pane) pane.onClose();
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
    files,
    link,
    loaded: current !== undefined,
    actions: {
      find: () => setFinding(true),
      "copy-link": () => void copyLink(),
      send: () => setSendingTo(true),
      files: () => setPanel("files"),
      delete: () => setDeleting(true),
    },
  });
  const phone = !useBreakpoint("sm");
  const failure = read.error;
  if (isGone(failure) || (failure && !current)) {
    const unavailable = (
      <ArtifactUnavailable
        gone={isGone(failure)}
        retrying={read.isFetching}
        onRetry={() => void read.refetch()}
        onClose={pane?.onClose}
      />
    );
    return pane ? <PaneFrame full={pane.full}>{unavailable}</PaneFrame> : unavailable;
  }
  const body = (
    <ArtifactCommentingContext.Provider value={commenting}>
      <ArtifactDraftsProvider enabled={current !== undefined}>
        <ShownThreadsContext.Provider value={shownThreads}>
          <CommentRequestsContext.Provider value={requests}>
            <CommentPlacesContext.Provider value={places}>
              <ArtifactPageHeader
                artifactId={artifactId}
                entryPath={entryPath}
                title={title}
                shownVersion={current ? shownVersion : undefined}
                home={home}
                homeName={homeName}
                pane={pane}
                onChooseVersion={choose}
                onFind={framesPage ? () => setFinding(true) : undefined}
                onCopyLink={current && (() => void copyLink())}
                comments={
                  current && (
                    <ArtifactCommentButton
                      total={current.commentCount}
                      active={commentMode.mode}
                      onToggle={commentMode.toggle}
                      onShowAll={commentMode.showAll}
                    />
                  )
                }
                pills={
                  current && (
                    <>
                      <VisibilityPill visibility={visibility} />
                      {home && (
                        <ArtifactHomeChip
                          home={home}
                          homeName={homeName}
                          scope={visibility.current}
                        />
                      )}
                      <ArtifactPresenceChip
                        workspaceId={workspaceId}
                        artifactId={artifactId}
                        ready={opened}
                      />
                    </>
                  )
                }
                menu={
                  current && (
                    <ArtifactMoreMenu
                      artifactId={artifactId}
                      shownVersion={shownVersion}
                      phone={phone}
                      fileCount={files.length}
                      canDelete={current.canDelete}
                      canFind={framesPage}
                      following={following}
                      visibility={visibility}
                      onChooseVersion={choose}
                      onAction={onMoreAction}
                    />
                  )
                }
              />
              <div className="relative flex min-h-0 flex-1">
                <div className="relative flex min-w-0 flex-1 flex-col">
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
                    <ArtifactMarkdown path={shownEntry(current)} text={current.text} />
                  ) : (
                    <ArtifactFile
                      artifactId={artifactId}
                      version={shownVersion}
                      path={shownEntry(current)}
                    />
                  )}
                  {current && <ArtifactReviewPill />}
                </div>
                {panel === "comments" && current && (
                  <ArtifactCommentPanel
                    artifactId={artifactId}
                    shownVersion={shownVersion}
                    openPath={openPath}
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
                  link={link.url !== null}
                  onClose={() => setSendingTo(false)}
                />
              )}
              <ArtifactDeleteConfirm
                open={deleting}
                onClose={() => setDeleting(false)}
                title={title}
                onDelete={async () => {
                  await deleteArtifact({ data: { artifactId } });
                  void refreshArtifact(queryClient, artifactId, homeId ?? null);
                  backHome();
                }}
              />
            </CommentPlacesContext.Provider>
          </CommentRequestsContext.Provider>
        </ShownThreadsContext.Provider>
      </ArtifactDraftsProvider>
    </ArtifactCommentingContext.Provider>
  );
  return pane ? (
    <PaneFrame full={pane.full}>{body}</PaneFrame>
  ) : (
    <main
      aria-labelledby={current ? ARTIFACT_TITLE_ID : undefined}
      aria-label={current ? undefined : m.doc_pane_label()}
      className="@container/doc flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary"
    >
      {body}
    </main>
  );
}
