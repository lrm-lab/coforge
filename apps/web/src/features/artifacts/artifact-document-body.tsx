import { AlertCircle, ClockRewind, Copy01, RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ContentEditor } from "#src/features/records/report-editor/content-editor";
import { m } from "#src/paraglide/messages";
import { conflictProgress } from "./artifact-conflict-model";
import { ArtifactConflictView } from "./artifact-conflict-view";
import { ArtifactDocumentFields } from "./artifact-document-fields";
import { ArtifactBanner } from "./artifact-pane-header";
import type { ArtifactActorRef } from "./artifact-queries";
import type { ArtifactEditor } from "./use-artifact-editor";

/**
 * A document's body on its page (task #385, #514): the latest version to edit, with what others
 * published meanwhile and a save's conflicts, or an older version to read and go back to.
 */

export function LatestVersion({
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
  const typing = editable && !editor.busy;
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
              disabled={editor.busy}
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
            <Button size="sm" color="tertiary" isDisabled={editor.busy} onClick={onDiscard}>
              {m.doc_conflict_discard()}
            </Button>
          )}
          <Button
            size="sm"
            color="primary"
            isDisabled={progress ? !progress.done : false}
            isLoading={editor.busy}
            onClick={() => void editor.save()}
          >
            {m.doc_save()}
          </Button>
        </footer>
      )}
    </>
  );
}

export function OldVersion({
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
