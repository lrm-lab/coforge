import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { AlertCircle, ClockRewind, Copy01, RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { ContentEditor } from "#src/features/records/report-editor/content-editor";
import { ArtifactDocumentFields } from "./artifact-document-fields";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppError } from "#src/lib/app-error";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { deleteArtifact, revertArtifact } from "./artifacts.functions";
import { conflictProgress } from "./artifact-conflict-model";
import { ArtifactConflictView } from "./artifact-conflict-view";
import { ArtifactHistory } from "./artifact-history";
import { useArtifactLeaveGuard } from "./artifact-leave-guard";
import { ArtifactPaneConfirms, type ArtifactConfirming } from "./artifact-pane-confirms";
import { artifactRoute } from "./artifact-link";
import { ArtifactBanner, ArtifactPaneHeader } from "./artifact-pane-header";
import { actorName, PaneFrame } from "./artifact-parts";
import {
  artifactDocumentQuery,
  artifactHomeConversation,
  refreshArtifact,
  useArtifactActor,
  type ArtifactActorRef,
} from "./artifact-queries";
import { decodeArtifactVersionPublishedEvent } from "./artifact-realtime";
import {
  closedArtifactSearch,
  useArtifactNavigation,
  type ArtifactSearch,
} from "./artifact-search";
import { useArtifactEditor, type ArtifactEditor } from "./use-artifact-editor";

const workspaceRoute = getRouteApi("/w/$workspaceSlug");

/**
 * An open document beside the conversation (task #385), or over it in full screen: its header,
 * the latest version to edit (or an older one to read), what others published meanwhile, a
 * save's conflicts to resolve, and its version history beside it. The address keeps which
 * document, version and view are open (`ArtifactSearch`).
 */
export function ArtifactPane({ search }: { search: ArtifactSearch & { doc: string } }) {
  const artifactId = search.doc;
  // A document opened again (another card) starts its editing anew.
  return <ArtifactPaneFor key={artifactId} artifactId={artifactId} search={search} />;
}

function ArtifactPaneFor({ artifactId, search }: { artifactId: string; search: ArtifactSearch }) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const navigate = useArtifactNavigation();
  const workspaceId = useCurrentWorkspaceId();
  const workspaceSlug = useWorkspaceSlug();
  const viewerId = workspaceRoute.useLoaderData({ select: (data) => data.user.id });
  const router = useRouter();
  const editor = useArtifactEditor(artifactId);
  const actorOf = useArtifactActor();
  const [confirming, setConfirming] = useState<ArtifactConfirming>(null);
  /** Set once the document is gone, so closing it asks nothing. */
  const deleted = useRef(false);
  const leavePrompt = useArtifactLeaveGuard({
    dirty: () => editor.dirty && !deleted.current,
    stays: (next) => next.doc === artifactId,
  });
  const old = search.docVersion;
  const oldRead = useQuery({
    ...artifactDocumentQuery(artifactId, old),
    enabled: old !== undefined,
  });
  const current = editor.document.data;
  const latest = current?.artifact.currentVersion ?? 0;
  const viewingOld = old !== undefined && old !== latest;

  const homeKey = current?.artifact.homeKey;
  const home = homeKey ? artifactHomeConversation(homeKey) : undefined;
  useRealtimeSubscription({
    channel:
      home === undefined || !workspaceId
        ? undefined
        : home
          ? conversationRealtimeChannel(home)
          : workspaceConversationChannel(workspaceId),
    recoverable: true,
    positioned: true,
    onPublication: ({ data }) => {
      const event = decodeArtifactVersionPublishedEvent(data);
      if (event?.artifactId !== artifactId) return;
      // The viewer's own versions (a revert, a save from another tab) need no announcing; the
      // viewer is known from the page, before the Workspace directory has loaded.
      const own = "userId" in event.publisher && event.publisher.userId === viewerId;
      editor.onPublished({ number: event.number, publisher: event.publisher }, { announce: !own });
    },
  });

  const close = () => navigate(closedArtifactSearch);
  if (editor.document.isError)
    return (
      <PaneFrame full={search.docFull} history={Boolean(search.docHistory)}>
        <ArtifactPaneHeader
          title={m.doc_pane_label()}
          status="readOnly"
          version={0}
          full={Boolean(search.docFull)}
          onToggleFull={() =>
            navigate({ docFull: search.docFull ? undefined : true }, { replace: true })
          }
          onClose={close}
        />
        <p className="p-6 text-sm text-tertiary">{m.doc_load_failed()}</p>
      </PaneFrame>
    );
  const title = editor.title || current?.artifact.title || m.doc_untitled();
  // The document's own conversation page, not this one: it opens for whoever reads that page.
  const route =
    current &&
    artifactRoute(
      workspaceSlug,
      { kind: current.homeKind, conversationId: home ?? null },
      artifactId,
    );
  const copyLink =
    route &&
    (() =>
      void copy(
        `${window.location.origin}${router.buildLocation(route).publicHref}`,
        m.doc_link_copied(),
      ));
  const copy = async (text: string, done: string) => {
    if (await copyText(text)) toast.success(done);
    else toast.error(m.conversation_copy_failed());
  };
  return (
    <PaneFrame full={search.docFull} history={Boolean(search.docHistory)}>
      <ArtifactPaneHeader
        title={title}
        status={viewingOld ? "old" : editor.status}
        version={viewingOld ? old! : (editor.base ?? 0)}
        full={Boolean(search.docFull)}
        history={Boolean(search.docHistory)}
        canDelete={current?.canDelete === true}
        onToggleHistory={() =>
          navigate({ docHistory: search.docHistory ? undefined : true }, { replace: true })
        }
        onToggleFull={() =>
          navigate({ docFull: search.docFull ? undefined : true }, { replace: true })
        }
        onCopyLink={copyLink}
        onDelete={() => setConfirming("delete")}
        onClose={close}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {viewingOld ? (
            <OldVersion
              key={old}
              number={old!}
              latest={latest}
              text={oldRead.data?.text}
              failed={oldRead.isError}
              onLatest={() => navigate({ docVersion: undefined }, { replace: true })}
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
        {search.docHistory && (
          // Beside the document when the pane has room for both, over its right edge when not.
          <aside className="absolute inset-y-0 right-0 flex w-64 shrink-0 flex-col border-l border-secondary bg-primary shadow-lg @3xl/doc:static @3xl/doc:shadow-none">
            <ArtifactHistory
              // Pages are cut at fixed versions: a new version starts them again from the top.
              key={latest}
              artifactId={artifactId}
              shown={old}
              onShow={(version) => navigate({ docVersion: version }, { replace: true })}
            />
          </aside>
        )}
      </div>
      {leavePrompt}
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
          close();
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
          navigate({ docVersion: undefined }, { replace: true });
        }}
      />
    </PaneFrame>
  );
}

function LatestVersion({
  editor,
  actorName,
  onDiscard,
  onCopyMine,
}: {
  editor: ArtifactEditor;
  actorName: (actor: ArtifactActorRef) => string;
  onDiscard: () => void;
  onCopyMine: () => void;
}) {
  const { conflict, published, document } = editor;
  if (!document.data || editor.base === null) return <div aria-busy="true" className="flex-1" />;
  const progress = conflict ? conflictProgress(conflict) : null;
  const editable = editor.status !== "readOnly";
  // Held while a save is in flight: text typed then would miss what the save merges in.
  const typing = editable && editor.status !== "saving";
  return (
    <>
      {editor.baseMoved && (
        <ArtifactBanner
          tone="warning"
          icon={AlertCircle}
          actions={
            <>
              {editor.dirty && (
                // What is unsaved can be kept elsewhere before the refresh drops it.
                <Button size="xs" color="link-gray" iconLeading={Copy01} onClick={onCopyMine}>
                  {m.doc_copy_mine()}
                </Button>
              )}
              <Button
                size="xs"
                color="secondary"
                iconLeading={RefreshCw01}
                // Unsaved edits are dropped only once the person confirms, as in a conflict.
                onClick={() => (editor.dirty ? onDiscard() : void editor.discard())}
              >
                {m.doc_refresh()}
              </Button>
            </>
          }
        >
          {m.doc_base_moved()}
        </ArtifactBanner>
      )}
      {conflict && progress && (
        <ArtifactBanner tone="warning" icon={AlertCircle}>
          {m.doc_conflict_banner({
            who: published ? actorName(published.publisher) : m.doc_someone(),
            number: String(conflict.currentVersion),
            count: String(progress.count),
          })}
        </ArtifactBanner>
      )}
      {!conflict && published && (
        <ArtifactBanner
          tone="info"
          icon={ClockRewind}
          actions={
            !editor.dirty && (
              <Button size="xs" color="link-gray" onClick={editor.dismissPublished}>
                {m.doc_close()}
              </Button>
            )
          }
        >
          {(editor.dirty ? m.doc_published_unsaved : m.doc_published_banner)({
            who: actorName(published.publisher),
            number: String(published.number),
          })}
        </ArtifactBanner>
      )}
      {editor.status === "readOnly" && (
        <ArtifactBanner tone="info" icon={AlertCircle}>
          {m.doc_read_only_hint()}
        </ArtifactBanner>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-6 pt-6 pb-16 md:px-10">
          {conflict ? (
            <ArtifactConflictView
              resolution={conflict}
              onChange={editor.setConflict}
              disabled={editor.status === "saving"}
            />
          ) : (
            <ArtifactDocumentFields
              editorRef={editor.editorRef}
              title={editor.title}
              text={editor.text}
              editable={typing}
              onTitle={(title) => editor.edit({ title })}
              onEdit={editor.markEdited}
              onText={(text) => editor.edit({ text })}
              onSave={() => void editor.save()}
            />
          )}
        </div>
      </div>
      {editable && (conflict || editor.dirty || editor.error) && (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-secondary px-4 py-2.5">
          <span className="min-w-0 flex-1 text-sm text-tertiary">
            {/* Unsaved edits alone need no words here: the header says so beside the title. */}
            {editor.error ??
              (progress &&
                m.doc_conflict_progress({
                  count: String(progress.count),
                  picked: String(progress.picked),
                }))}
          </span>
          {conflict && (
            <Button size="sm" color="tertiary" onClick={onDiscard}>
              {m.doc_conflict_discard()}
            </Button>
          )}
          <Button
            size="sm"
            color="primary"
            isDisabled={progress ? !progress.done : false}
            isLoading={editor.status === "saving"}
            onClick={() => void editor.save()}
          >
            {m.doc_save()}
          </Button>
        </footer>
      )}
    </>
  );
}

function OldVersion({
  number,
  latest,
  text,
  failed,
  onLatest,
  onRevert,
}: {
  number: number;
  latest: number;
  text: string | undefined;
  /** The version could not be read: said so, with the way back to the latest above it. */
  failed: boolean;
  onLatest: () => void;
  onRevert: () => void;
}) {
  return (
    <>
      <ArtifactBanner
        tone="info"
        icon={ClockRewind}
        actions={
          <>
            <Button size="xs" color="secondary" onClick={onRevert}>
              {m.doc_revert()}
            </Button>
            <Button size="xs" color="primary" onClick={onLatest}>
              {m.doc_back_to_latest()}
            </Button>
          </>
        }
      >
        {m.doc_old_banner({ number: String(number), latest: String(latest) })}
      </ArtifactBanner>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-6 pt-6 pb-16 md:px-10">
          {failed ? (
            <p className="text-sm text-tertiary">{m.doc_version_load_failed()}</p>
          ) : text === undefined ? (
            <div aria-busy="true" />
          ) : (
            <ContentEditor editable={false} defaultValue={text} showBubbleMenu={false} />
          )}
        </div>
      </div>
    </>
  );
}
