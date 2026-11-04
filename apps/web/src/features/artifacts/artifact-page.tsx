import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { AlertCircle, ClockRewind, RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppError } from "#src/lib/app-error";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { deleteArtifact, revertArtifact } from "./artifacts.functions";
import { LatestVersion, OldVersion } from "./artifact-document-body";
import { ArtifactHistory } from "./artifact-history";
import { ArtifactBanner } from "./artifact-pane-header";
import { loadArtifactSandboxLink } from "./artifact-sandbox.functions";
import { useArtifactLeaveGuard } from "./artifact-leave-guard";
import { useArtifactAccess } from "./artifact-access";
import {
  ARTIFACT_TITLE_ID,
  ArtifactPageHeader,
  useHomeName,
  type ArtifactHome,
} from "./artifact-page-header";
import { ACCESS_ICON, ArtifactShareDialog } from "./artifact-share-dialog";
import { ArtifactPaneConfirms, type ArtifactConfirming } from "./artifact-pane-confirms";
import { actorName, isWebPage } from "./artifact-parts";
import {
  artifactDocumentQuery,
  artifactHomeConversation,
  refreshArtifact,
  useArtifactActor,
} from "./artifact-queries";
import { decodeArtifactVersionPublishedEvent } from "./artifact-realtime";
import { artifactPageRoute, type ArtifactPageSearch } from "./artifact-search";
import { ArtifactWebPage } from "./artifact-web-page";
import { useArtifactEditor } from "./use-artifact-editor";

const workspaceRoute = getRouteApi("/w/$workspaceSlug");

/**
 * An artifact's own page (task #514; before it, the pane beside the chat of task #385): its
 * header, a document's latest version to edit (or an older one to read) or a web page to look at,
 * what others published meanwhile, a save's conflicts, and its versions beside it. The address
 * keeps which version and whether the versions show (`ArtifactPageSearch`).
 */
export function ArtifactPage({
  artifactId,
  search,
}: {
  artifactId: string;
  search: ArtifactPageSearch;
}) {
  // An address that names no artifact at all is not there: no read could find one.
  if (!z.uuid().safeParse(artifactId).success) return <ArtifactUnavailable gone />;
  // Another artifact's page starts its editing anew.
  return <ArtifactPageFor key={artifactId} artifactId={artifactId} search={search} />;
}

function ArtifactPageFor({
  artifactId,
  search,
}: {
  artifactId: string;
  search: ArtifactPageSearch;
}) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const router = useRouter();
  const workspaceId = useCurrentWorkspaceId();
  const workspaceSlug = useWorkspaceSlug();
  const viewerId = workspaceRoute.useLoaderData({ select: (data) => data.user.id });
  const editor = useArtifactEditor(artifactId);
  const actorOf = useArtifactActor();
  const [confirming, setConfirming] = useState<ArtifactConfirming>(null);
  const [sharing, setSharing] = useState(false);
  /** Set once the artifact is gone, so leaving its page asks nothing. */
  const deleted = useRef(false);
  const navigate = (patch: ArtifactPageSearch) =>
    void router.navigate({
      ...artifactPageRoute(workspaceSlug, artifactId),
      search: (previous: ArtifactPageSearch) => ({ ...previous, ...patch }),
      replace: true,
    });
  const leavePrompt = useArtifactLeaveGuard({
    dirty: () => editor.dirty && !deleted.current,
    stays: (next) => next.pathname === router.state.location.pathname,
  });
  const old = search.version;
  const oldRead = useQuery({
    ...artifactDocumentQuery(artifactId, old),
    enabled: old !== undefined,
  });
  const current = editor.document.data;
  const latest = current?.artifact.currentVersion ?? 0;
  const viewingOld = old !== undefined && old !== latest;

  const homeKey = current?.artifact.homeKey;
  const homeId = homeKey ? artifactHomeConversation(homeKey) : undefined;
  const home: ArtifactHome | undefined = current && {
    kind: current.homeKind,
    conversationId: homeId ?? null,
  };
  const homeName = useHomeName(home);
  const access = useArtifactAccess(artifactId, current?.artifact);
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
      const event = decodeArtifactVersionPublishedEvent(data);
      if (event?.artifactId !== artifactId) return;
      // The viewer's own versions (a revert, a save from another tab) need no announcing.
      const own = "userId" in event.publisher && event.publisher.userId === viewerId;
      editor.onPublished({ number: event.number, publisher: event.publisher }, { announce: !own });
    },
  });

  // Gone or not the viewer's (the server says so), or never read: the page is not there. A read
  // that failed once the artifact showed keeps it, and its unsaved edits, with a way to try again.
  const failure = editor.document.error;
  if (isGone(failure) || (failure && !current))
    return (
      <>
        <ArtifactUnavailable
          gone={isGone(failure)}
          retrying={editor.document.isFetching}
          onRetry={() => void editor.document.refetch()}
        />
        {leavePrompt}
      </>
    );
  const kind = current?.artifact.kind;
  const webPage = kind !== undefined && isWebPage(kind);
  const title = editor.title || current?.artifact.title || m.doc_untitled();
  const copy = async (text: string, done: string) => {
    if (await copyText(text)) toast.success(done);
    else toast.error(m.conversation_copy_failed());
  };
  const pageHref = () =>
    `${window.location.origin}${router.buildLocation(artifactPageRoute(workspaceSlug, artifactId)).publicHref}`;
  const backHome = () => {
    if (home?.conversationId && home.kind !== "workspace")
      void router.navigate(
        conversationRoute(
          home.kind === "channel"
            ? { channelId: home.conversationId }
            : { dmId: home.conversationId },
          workspaceSlug,
        ),
      );
    else void router.navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug } });
  };
  return (
    <main
      aria-labelledby={current ? ARTIFACT_TITLE_ID : undefined}
      aria-label={current ? undefined : m.doc_pane_label()}
      className="@container/doc flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary"
    >
      <ArtifactPageHeader
        kind={kind}
        title={title}
        status={viewingOld ? "old" : editor.status}
        version={viewingOld ? old! : (editor.base ?? 0)}
        home={home}
        history={Boolean(search.history)}
        canDelete={current?.canDelete === true}
        shareIcon={ACCESS_ICON[access.access]}
        onShare={current && (() => setSharing(true))}
        onToggleHistory={
          current && (() => navigate({ history: search.history ? undefined : true }))
        }
        onCopyLink={current && (() => void copy(pageHref(), m.doc_link_copied()))}
        onOpenInTab={
          webPage
            ? () =>
                void openInTab(artifactId, viewingOld ? old! : latest).catch(() =>
                  toast.error(m.doc_open_in_tab_failed()),
                )
            : undefined
        }
        onDelete={() => setConfirming("delete")}
      />
      {failure && (
        <ArtifactBanner
          tone="warning"
          icon={AlertCircle}
          actions={
            <Button
              size="xs"
              color="secondary"
              iconLeading={RefreshCw01}
              isLoading={editor.document.isFetching}
              onClick={() => void editor.document.refetch()}
            >
              {m.doc_retry()}
            </Button>
          }
        >
          {m.doc_refresh_failed()}
        </ArtifactBanner>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {!current ? (
            <LoadingBody />
          ) : webPage ? (
            <>
              {viewingOld && (
                // An older web page reads only: no going back to it, as a person does not write
                // web pages (task #490); the way back to the latest is the one action.
                <ArtifactBanner
                  tone="info"
                  icon={ClockRewind}
                  actions={
                    <Button
                      size="xs"
                      color="primary"
                      onClick={() => navigate({ version: undefined })}
                    >
                      {m.doc_back_to_latest()}
                    </Button>
                  }
                >
                  {m.doc_old_banner({ number: String(old), latest: String(latest) })}
                </ArtifactBanner>
              )}
              {!viewingOld &&
                editor.published && (
                  // An Agent saved a new version: the page shows it already; this says who.
                  <ArtifactBanner
                    tone="info"
                    icon={ClockRewind}
                    actions={
                      <Button size="xs" color="link-gray" onClick={editor.dismissPublished}>
                        {m.doc_close()}
                      </Button>
                    }
                  >
                    {m.doc_published_banner({
                      who: actorName(actorOf(editor.published.publisher)),
                      number: String(editor.published.number),
                    })}
                  </ArtifactBanner>
                )}
              <ArtifactWebPage
                key={old ?? latest}
                artifactId={artifactId}
                version={viewingOld ? old! : latest}
                title={title}
                source={viewingOld ? oldRead.data?.text : current.text}
                sourceFailed={viewingOld && oldRead.isError}
              />
            </>
          ) : viewingOld ? (
            <OldVersion
              key={old}
              number={old!}
              latest={latest}
              text={oldRead.data?.text}
              failed={oldRead.isError}
              onLatest={() => navigate({ version: undefined })}
              onRevert={() => setConfirming({ revert: old! })}
            />
          ) : (
            <LatestVersion
              editor={editor}
              actorName={(actor) => actorName(actorOf(actor))}
              onDiscard={() => setConfirming("discard")}
              onCopyMine={() =>
                void copy(
                  editor.editorRef.current?.getMarkdown() ?? editor.text,
                  m.doc_mine_copied(),
                )
              }
            />
          )}
        </div>
        {search.history &&
          current && (
            // Beside the artifact when the page has room for both, over its right edge when not.
            <aside className="absolute inset-y-0 right-0 flex w-72 shrink-0 flex-col border-l border-secondary bg-primary shadow-lg @3xl/doc:static @3xl/doc:shadow-none">
              <ArtifactHistory
                // Pages are cut at fixed versions: a new version starts them again from the top.
                key={latest}
                artifactId={artifactId}
                shown={old}
                onShow={(version) => navigate({ version })}
              />
            </aside>
          )}
      </div>
      {leavePrompt}
      <ArtifactShareDialog
        open={sharing}
        onOpenChange={(open) => {
          setSharing(open);
          if (!open) access.dismiss();
        }}
        title={title}
        homeKind={home?.kind ?? "channel"}
        homeName={homeName}
        state={access}
        onCopyLink={() => void copy(pageHref(), m.doc_link_copied())}
      />
      <ArtifactPaneConfirms
        confirming={confirming}
        onDone={() => setConfirming(null)}
        title={title}
        latest={latest}
        dirty={editor.dirty}
        onDiscard={editor.discard}
        onDelete={async () => {
          await deleteArtifact({ data: { artifactId } });
          refreshArtifact(queryClient, artifactId);
          deleted.current = true;
          backHome();
        }}
        onRevert={async (to) => {
          try {
            await revertArtifact({
              data: { artifactId, to, baseVersion: latest, idempotencyKey: crypto.randomUUID() },
            });
          } catch (cause) {
            if (isAppError(cause) && cause.errorId === "artifact-base-moved")
              throw new Error(m.doc_revert_moved());
            throw cause;
          }
          refreshArtifact(queryClient, artifactId);
          // Unsaved edits stay: the version this makes is announced, and the next save merges it.
          if (!editor.dirty) await editor.takeLatest();
          navigate({ version: undefined });
        }}
      />
    </main>
  );
}

/**
 * A web page in a tab of its own: the sandbox's link, asked for on the click (it is short-lived).
 * The tab opens at once, so no pop-up blocker takes it for one the page opened by itself, and is
 * cut off from this page before it goes to the link; a link that cannot be had closes it, and
 * throws for the page to say so.
 */
async function openInTab(artifactId: string, version: number) {
  const tab = window.open("", "_blank");
  if (!tab) return;
  tab.opener = null;
  try {
    tab.location.href = (await loadArtifactSandboxLink({ data: { artifactId, version } })).url;
  } catch (cause) {
    tab.close();
    throw cause;
  }
}

/** The server's answer for an artifact that is not there for the viewer: deleted, never there,
 * or not theirs to read. */
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

/**
 * The page with no artifact to show. Deleted, never there, or not the viewer's to see: the server
 * does not say which, so neither does the page (`gone`). A read that failed otherwise, before
 * anything showed, says so and tries again.
 */
function ArtifactUnavailable({
  gone,
  retrying = false,
  onRetry,
}: {
  gone: boolean;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-primary px-6 text-center">
      <h1 className="text-md font-semibold text-primary">
        {gone ? m.doc_unavailable_title() : m.doc_load_failed_title()}
      </h1>
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
          onClick={() =>
            void router.navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug } })
          }
        >
          {m.doc_back_to_workspace()}
        </Button>
      </div>
    </main>
  );
}
