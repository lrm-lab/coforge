import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { isAppError } from "#src/lib/app-error";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { deleteArtifact } from "./artifacts.functions";
import { ArtifactDeleteConfirm } from "./artifact-delete-confirm";
import { ArtifactFileView } from "./artifact-file-view";
import { ArtifactCommentButton } from "./artifact-comment-button";
import { ArtifactCommentPanel } from "./artifact-comment-panel";
import {
  ArtifactCommentingContext,
  CommentPlacesContext,
  CommentRequestsContext,
  CommentThreadsContext,
  type ArtifactCommenting,
  type CommentRequests,
  type CommentTarget,
  type PublishedPlaces,
} from "./artifact-commenting";
import { isFrameAnchor } from "./artifact-page-annotations";
import { groupThreads } from "./artifact-comment-threads";
import { useArtifactComments, syncCommentsChange } from "./artifact-comment-queries";
import { useCommentHandoff } from "./use-comment-handoff";
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
import { ArtifactPresenceChip, useKeepViewing, useRecordOpen } from "./artifact-presence-chip";
import { ArtifactSendDialog } from "./artifact-send-dialog";
import { ArtifactUpdateBanner, ViewingVersionNotice } from "./artifact-update-banner";
import { isWebPageEntry } from "./artifact-path-kind";
import { PaneFrame } from "./artifact-parts";
import {
  artifactDocumentQuery,
  artifactHomeConversation,
  refreshArtifact,
} from "./artifact-queries";
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

type ArtifactPlace = { pane?: ArtifactPaneControls };

export function ArtifactPage({ artifactId, pane }: { artifactId: string } & ArtifactPlace) {
  if (!z.uuid().safeParse(artifactId).success)
    return pane ? (
      <PaneFrame full={pane.full}>
        <ArtifactUnavailable gone />
      </PaneFrame>
    ) : (
      <ArtifactUnavailable gone />
    );
  return <ArtifactPageFor key={artifactId} artifactId={artifactId} pane={pane} />;
}

function ArtifactPageFor({ artifactId, pane }: { artifactId: string } & ArtifactPlace) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const router = useRouter();
  const workspaceId = useCurrentWorkspaceId();
  const workspaceSlug = useWorkspaceSlug();
  const read = useQuery(artifactDocumentQuery(artifactId));
  const [pinned, setPinned] = useState<number | null>(null);
  const [incoming, setIncoming] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sendingTo, setSendingTo] = useState(false);
  const [finding, setFinding] = useState(false);
  const [panel, setPanel] = useState<ArtifactPanelName | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const commentMode = useCommentMode(setPanel);
  const [places, setPlaces] = useState<PublishedPlaces>(null);
  const latest = read.data?.artifact.currentVersion ?? 0;
  const older = pinned !== null && pinned !== latest;
  const pinnedRead = useQuery({
    ...artifactDocumentQuery(artifactId, pinned ?? undefined),
    enabled: older,
  });
  const current = older ? (pinnedRead.data ?? read.data) : read.data;
  const shownVersion = older && pinnedRead.data ? pinned : latest;

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
        if (commentsChange.artifactId === artifactId)
          void syncCommentsChange(queryClient, commentsChange);
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
        void refreshArtifact(queryClient, artifactId, homeId ?? null, { document: false });
        return;
      }
      if (decodeArtifactAccessChangedEvent(data)?.artifactId === artifactId)
        void refreshArtifact(queryClient, artifactId, homeId ?? null);
    },
  });

  const opened = useRecordOpen(artifactId, latest);
  useKeepViewing(artifactId, latest > 0);

  const entryPath = current?.artifact.entryPath;
  const webPage = entryPath !== undefined && isWebPageEntry(entryPath);
  const files = current?.files ?? [];
  const filePaths = useMemo(
    () => (current?.files ?? []).map((file) => file.path),
    [current?.files],
  );
  const commentsOpen = commentMode.mode || panel === "comments";
  const shownPath = openPath ?? entryPath;
  const [reveal, postReveal, consumeReveal] = useCommentHandoff<CommentTarget>(
    (target) => commentsOpen && target.path === shownPath,
  );
  const [focus, postFocus, consumeFocus] = useCommentHandoff<string>(() => panel === "comments");
  const list = useArtifactComments(artifactId, commentsOpen);
  const groups = useMemo(() => groupThreads(list.comments), [list.comments]);
  const publishPlaces = useCallback<ArtifactCommenting["publishPlaces"]>(
    (path, byId) =>
      setPlaces((held) => (byId ? { path, byId } : held?.path === path ? null : held)),
    [],
  );
  const revealThread = useCallback<ArtifactCommenting["revealThread"]>(
    (target) => {
      const framed = webPage && target.path === entryPath && isFrameAnchor(target.anchor);
      setOpenPath(framed || (target.path === entryPath && !webPage) ? null : target.path);
      if (framed || !webPage || target.path !== entryPath || target.anchor?.type === "lines")
        postReveal(target);
    },
    [entryPath, webPage, postReveal],
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
      publishPlaces,
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
  const pageHref = () =>
    `${window.location.origin}${router.buildLocation(artifactPageRoute(workspaceSlug, artifactId)).publicHref}`;
  const backHome = () => {
    if (pane) pane.onClose();
    else void router.navigate(homeLinkProps(home, workspaceSlug));
  };
  const viewLatest = () => {
    setIncoming(null);
    setPinned(null);
    setOpenPath(null);
    void refreshArtifact(queryClient, artifactId, homeId ?? null);
  };
  const choose = (version: number) => {
    setOpenPath(null);
    setPinned(version === latest ? null : version);
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
      "copy-link": () => void copy(pageHref(), m.doc_link_copied()),
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
      <CommentThreadsContext.Provider value={groups.anchored}>
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
              onFind={webPage && !openPath ? () => setFinding(true) : undefined}
              onCopyLink={current && (() => void copy(pageHref(), m.doc_link_copied()))}
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
                    <ArtifactPresenceChip artifactId={artifactId} ready={opened} />
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
                    canFind={webPage}
                    following={following}
                    visibility={visibility}
                    onChooseVersion={choose}
                    onAction={onMoreAction}
                  />
                )
              }
            />
            <div className="relative flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                {incoming !== null && incoming > latest && (
                  <ArtifactUpdateBanner
                    artifactId={artifactId}
                    incoming={incoming}
                    onView={viewLatest}
                  />
                )}
                {older && (
                  <ViewingVersionNotice
                    version={pinned}
                    failed={pinnedRead.isError}
                    onBack={() => setPinned(null)}
                  />
                )}
                {!current ? (
                  <LoadingBody />
                ) : openPath ? (
                  <ArtifactFileView
                    artifactId={artifactId}
                    version={shownVersion}
                    path={openPath}
                    onBack={() => setOpenPath(null)}
                  />
                ) : webPage ? (
                  <ArtifactWebPage
                    key={shownVersion}
                    artifactId={artifactId}
                    version={shownVersion}
                    title={title}
                    entryPath={current.artifact.entryPath}
                    finding={finding}
                    onFindingChange={setFinding}
                  />
                ) : (
                  <ArtifactMarkdown path={current.artifact.entryPath} text={current.text} />
                )}
              </div>
              {panel === "comments" && current && (
                <ArtifactCommentPanel
                  artifactId={artifactId}
                  shownVersion={shownVersion}
                  openPath={openPath}
                  list={list}
                  groups={groups}
                  onClose={commentMode.closePanel}
                />
              )}
              {panel === "files" && current && (
                <ArtifactFilesPanel
                  artifactId={artifactId}
                  version={shownVersion}
                  entryPath={current.artifact.entryPath}
                  files={files}
                  openPath={openPath}
                  onOpen={setOpenPath}
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
      </CommentThreadsContext.Provider>
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

const isGone = (error: unknown) =>
  isAppError(error) && (error.code === "NOT_FOUND" || error.code === "ACCESS_DENIED");

function LoadingBody() {
  return (
    <div aria-busy="true" className="mx-auto w-full max-w-[46rem] space-y-4 px-6 pt-8 md:px-10">
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function ArtifactUnavailable({
  gone,
  retrying = false,
  onRetry,
  onClose,
}: {
  gone: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  onClose?: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  const Root = onClose ? "div" : "main";
  const Title = onClose ? "h2" : "h1";
  return (
    <Root className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-primary px-6 text-center">
      <Title className="text-md font-semibold text-primary">
        {gone ? m.doc_unavailable_title() : m.doc_load_failed_title()}
      </Title>
      <p className="max-w-sm text-sm text-tertiary">
        {gone ? m.doc_load_failed() : m.doc_load_failed_retry()}
      </p>
      <div className="flex items-center gap-4">
        {!gone && onRetry && (
          <Button
            size="sm"
            color="secondary"
            iconLeading={RefreshCw01}
            isLoading={retrying}
            onClick={onRetry}
          >
            {m.doc_retry()}
          </Button>
        )}
        <Button
          size="sm"
          color="link-gray"
          onClick={
            onClose ??
            (() => void router.navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug } }))
          }
        >
          {onClose ? m.doc_close() : m.doc_back_to_workspace()}
        </Button>
      </div>
    </Root>
  );
}
