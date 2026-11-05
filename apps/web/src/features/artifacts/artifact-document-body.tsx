import { useState } from "react";
import { AlertCircle, Copy01, RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { ArtifactDocumentFields } from "./artifact-document-fields";
import { ArtifactBanner } from "./artifact-pane-header";
import type { ArtifactEditor } from "./use-artifact-editor";

/**
 * A document's body (task #385, #514): its text to edit, saved as typing rests, and a save that
 * failed.
 */

/** Documents just created from a draft: their editor takes the caret back, at the end. */
export const focusWhenShown = new Set<string>();

export function LatestVersion({
  editor,
  onDiscard,
  onCopyMine,
  onRetry,
}: {
  editor: ArtifactEditor;
  onDiscard: () => void;
  onCopyMine: () => void;
  /** Try Again on a failed save: it saves, and reads the artifact again if that failed too. */
  onRetry: () => void;
}) {
  const { document } = editor;
  const [focusEnd] = useState(() => {
    const id = document.data?.artifact.id;
    return id !== undefined && focusWhenShown.delete(id);
  });
  if (!document.data || editor.base === null) return <div aria-busy="true" className="flex-1" />;
  const editable = editor.status !== "readOnly";
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
                // Unsaved edits are dropped only once the person confirms.
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
      {editor.status === "readOnly" && (
        <ArtifactBanner tone="info" icon={AlertCircle}>
          {m.doc_read_only_hint()}
        </ArtifactBanner>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-6 pt-6 pb-16 md:px-10">
          <ArtifactDocumentFields
            editorRef={editor.editorRef}
            title={editor.title}
            text={editor.text}
            editable={editable}
            onTitle={(title) => editor.edit({ title })}
            onEdit={editor.markEdited}
            onText={(text) => editor.edit({ text })}
            onSave={() => void editor.save()}
            autoFocus={focusEnd ? "end" : undefined}
          />
        </div>
      </div>
      {/* Edits save by themselves: the footer is for a save that failed. */}
      {editable && editor.error && (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-secondary px-4 py-2.5">
          <span className="min-w-0 flex-1 text-sm text-tertiary">{editor.error}</span>
          <Button size="sm" color="primary" isLoading={editor.busy} onClick={onRetry}>
            {m.doc_retry()}
          </Button>
        </footer>
      )}
    </>
  );
}
