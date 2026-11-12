import { useState } from "react";
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
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppError } from "#src/lib/app-error";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { deleteArtifact } from "./artifacts.functions";
import { ArtifactDeleteConfirm } from "./artifact-delete-confirm";
import { ArtifactMarkdown } from "./artifact-markdown";
import { loadArtifactSandboxLink } from "./artifact-sandbox.functions";
import { useArtifactAccess } from "./artifact-access";
import {
  ARTIFACT_TITLE_ID,
  ArtifactPageHeader,
  useHomeName,
  type ArtifactHome,
  type ArtifactPaneControls,
} from "./artifact-page-header";
import { useArtifactLinkSharing } from "./artifact-link-sharing";
import { ArtifactSendDialog } from "./artifact-send-dialog";
import { ArtifactShareDialog, shareIcon } from "./artifact-share-dialog";
import { isWebPage, PaneFrame } from "./artifact-parts";
import {
  artifactDocumentQuery,
  artifactHomeConversation,
  refreshArtifact,
} from "./artifact-queries";
import { decodeArtifactVersionPublishedEvent } from "./artifact-realtime";
import { artifactPageRoute } from "./artifact-search";
import { ArtifactWebPage } from "./artifact-web-page";

/** Where an artifact shows: on its own page, or beside its conversation's chat (Frank, 11-05),
 * which closes rather than goes back. */
type ArtifactPlace = { pane?: ArtifactPaneControls };

/**
 * An artifact's own page (task #514), or the pane beside its conversation's chat (Frank, 11-05,
 * as Claude opens an artifact beside the conversation): its header, and its document or web page
 * to read. People view and comment; an Agent writes it. A version published meanwhile is read in.
 */
export function ArtifactPage({ artifactId, pane }: { artifactId: string } & ArtifactPlace) {
  // An address that names no artifact at all is not there: no read could find one.
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
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [sendingTo, setSendingTo] = useState(false);
  const current = read.data;
  const latest = current?.artifact.currentVersion ?? 0;

  const homeKey = current?.artifact.homeKey;
  const homeId = homeKey ? artifactHomeConversation(homeKey) : undefined;
  const home: ArtifactHome | undefined = current && {
    kind: current.homeKind,
    conversationId: homeId ?? null,
  };
  const homeName = useHomeName(home);
  // Narrowed past the viewer: their page is not theirs any more; back to the Workspace, saying so.
  const access = useArtifactAccess(artifactId, current?.artifact, async () => {
    if (pane) pane.onClose();
    else await router.navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug } });
    toast.success(m.doc_share_locked_out({ title }));
  });
  const link = useArtifactLinkSharing(artifactId, current !== undefined);
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
      // Taken in quietly: nothing says who changed it (Frank, 11-05).
      void refreshArtifact(queryClient, artifactId);
    },
  });

  // Gone or not the viewer's (the server says so), or never read: the page is not there. A read
  // that failed once the artifact showed keeps it.
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
  const kind = current?.artifact.kind;
  const webPage = kind !== undefined && isWebPage(kind);
  const title = current?.artifact.title || m.doc_untitled();
  const copy = async (text: string, done: string) => {
    if (await copyText(text)) toast.success(done);
    else toast.error(m.conversation_copy_failed());
  };
  const pageHref = () =>
    `${window.location.origin}${router.buildLocation(artifactPageRoute(workspaceSlug, artifactId)).publicHref}`;
  const backHome = () => {
    if (pane) pane.onClose();
    else if (home?.conversationId && home.kind !== "workspace")
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
  const body = (
    <>
      <ArtifactPageHeader
        kind={kind}
        title={title}
        version={current?.artifact.currentVersion}
        home={home}
        canDelete={current?.canDelete === true}
        shareIcon={shareIcon(access.access, link)}
        onShare={
          current &&
          (() => {
            link.refresh();
            setSharing(true);
          })
        }
        onCopyLink={current && (() => void copy(pageHref(), m.doc_link_copied()))}
        onOpenInTab={
          webPage
            ? () =>
                void openInTab(artifactId, latest).catch(() =>
                  toast.error(m.doc_open_in_tab_failed()),
                )
            : undefined
        }
        onDelete={() => setDeleting(true)}
        pane={pane}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {!current ? (
            <LoadingBody />
          ) : webPage ? (
            <ArtifactWebPage key={latest} artifactId={artifactId} version={latest} title={title} />
          ) : (
            <ArtifactMarkdown text={current.text} />
          )}
        </div>
      </div>
      <ArtifactShareDialog
        open={sharing}
        onOpenChange={(open) => {
          setSharing(open);
          if (!open) {
            access.dismiss();
            link.dismiss();
          }
        }}
        title={title}
        homeKind={home?.kind ?? "channel"}
        homeName={homeName}
        state={access}
        link={link}
        onCopyLink={() => void copy(pageHref(), m.doc_link_copied())}
        onCopyPublicLink={(url) => void copy(url, m.doc_public_link_copied())}
        onSend={() => {
          setSharing(false);
          access.dismiss();
          link.dismiss();
          setSendingTo(true);
        }}
      />
      {sendingTo && (
        <ArtifactSendDialog
          artifactId={artifactId}
          title={title}
          onClose={() => setSendingTo(false)}
        />
      )}
      <ArtifactDeleteConfirm
        open={deleting}
        onClose={() => setDeleting(false)}
        title={title}
        onDelete={async () => {
          await deleteArtifact({ data: { artifactId } });
          void refreshArtifact(queryClient, artifactId);
          backHome();
        }}
      />
    </>
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
  onClose,
}: {
  gone: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  /** Beside the chat: the way out closes the pane rather than leaving the conversation. */
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
