import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import type { ContentEditorRef } from "#src/features/records/report-editor/content-editor";
import { m } from "#src/paraglide/messages";
import { createArtifactDocument } from "./artifacts.functions";
import { ArtifactDocumentFields } from "./artifact-document-fields";
import { focusWhenShown } from "./artifact-document-body";
import { useArtifactLeaveGuard } from "./artifact-leave-guard";
import { ArtifactPageHeader } from "./artifact-page-header";
import { PaneFrame } from "./artifact-parts";
import { refreshArtifact } from "./artifact-queries";
import { nextSaveAttempt, type SaveAttempt } from "./artifact-save-attempt";
import { AUTOSAVE_MS } from "./artifact-autosave";
import {
  closedArtifactSearch,
  openArtifactSearch,
  useArtifactNavigation,
  type ArtifactSearch,
} from "./artifact-search";

/**
 * A new document before its first save (task #385): written in the pane like any other, and
 * created in the conversation once typing rests, so a "New document" closed unwritten leaves
 * nothing behind - as Raft creates a document on its first push.
 */
export function ArtifactDraftPane({
  conversationId,
  search,
}: {
  conversationId: string;
  search: ArtifactSearch;
}) {
  const queryClient = useQueryClient();
  const navigate = useArtifactNavigation();
  const editorRef = useRef<ContentEditorRef>(null);
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  /** Counts the person's edits, so the first save waits for typing to rest. */
  const [editTick, setEditTick] = useState(0);
  /** Set once the draft is a document, so opening it asks nothing. */
  const created = useRef(false);
  /** Set while the pane closes with the draft saving on the way out: it does not open then. */
  const leaving = useRef(false);
  /** The last create sent: retried as it was, it keeps its key, and the server answers with the
   * document a lost answer already made rather than a second one. */
  const attempt = useRef<SaveAttempt | null>(null);
  const create = useMutation({
    mutationFn: () => {
      const draft = {
        title: title.trim() || m.doc_untitled(),
        // The editor holds the text: it is read once, to save.
        text: editorRef.current?.getMarkdown() ?? "",
      };
      attempt.current = nextSaveAttempt(attempt.current, { baseVersion: 0, ...draft });
      return createArtifactDocument({
        data: { conversationId, idempotencyKey: attempt.current.key, ...draft },
      });
    },
    onSuccess: (document) => {
      created.current = true;
      void refreshArtifact(queryClient, document.id);
      if (leaving.current) return;
      // Saved, it is a document like any other, still beside the chat, its text where it was.
      focusWhenShown.add(document.id);
      navigate(openArtifactSearch(document.id), { replace: true });
    },
  });
  const leavePrompt = useArtifactLeaveGuard({
    dirty: () => dirty && !created.current,
    stays: (next) => next.search.docDraft === true,
    save: async () => {
      leaving.current = true;
      try {
        await create.mutateAsync();
        return true;
      } catch {
        leaving.current = false;
        return false;
      }
    },
  });
  const markEdited = () => {
    setDirty(true);
    setEditTick((tick) => tick + 1);
    if (create.isError) create.reset();
  };
  const save = () => {
    if (!create.isPending && !created.current) create.mutate();
  };
  // Created once typing rests, as a saved document's edits save (`AUTOSAVE_MS`); a failed
  // create waits for the next edit or Try Again.
  const autosave = useEffectEvent(save);
  const canAutosave = dirty && !create.isPending && !create.isError;
  useEffect(() => {
    if (!canAutosave) return;
    const timer = setTimeout(autosave, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [canAutosave, editTick]);
  return (
    <PaneFrame full={search.docFull}>
      <ArtifactPageHeader
        kind="markdown"
        title={title.trim() || m.doc_untitled()}
        status={create.isPending ? "saving" : dirty ? "unsaved" : "saved"}
        home={undefined}
        canDelete={false}
        pane={{
          full: Boolean(search.docFull),
          onToggleFull: () =>
            navigate({ docFull: search.docFull ? undefined : true }, { replace: true }),
          onClose: () => navigate(closedArtifactSearch),
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-6 pt-6 pb-16 md:px-10">
          <ArtifactDocumentFields
            editorRef={editorRef}
            title={title}
            text=""
            editable={!create.isPending}
            onTitle={(next) => {
              setTitle(next);
              markEdited();
            }}
            onEdit={markEdited}
            onSave={save}
          />
        </div>
      </div>
      {create.isError && (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-secondary px-4 py-2.5">
          <span className="min-w-0 flex-1 text-sm text-tertiary">{m.doc_new_failed()}</span>
          <Button size="sm" color="primary" isLoading={create.isPending} onClick={save}>
            {m.doc_retry()}
          </Button>
        </footer>
      )}
      {leavePrompt}
    </PaneFrame>
  );
}
