import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import type { ContentEditorRef } from "#src/features/records/report-editor/content-editor";
import { m } from "#src/paraglide/messages";
import { createArtifactDocument } from "./artifacts.functions";
import { ArtifactDocumentFields } from "./artifact-document-fields";
import { useArtifactLeaveGuard } from "./artifact-leave-guard";
import { ArtifactPaneHeader } from "./artifact-pane-header";
import { PaneFrame } from "./artifact-parts";
import { refreshArtifact } from "./artifact-queries";
import { nextSaveAttempt, type SaveAttempt } from "./artifact-save-attempt";
import {
  closedArtifactSearch,
  useOpenArtifactPage,
  useArtifactNavigation,
  type ArtifactSearch,
} from "./artifact-search";

/**
 * A new document before its first save (task #385): written in the pane like any other, and
 * created in the conversation only when saved, so a "New document" closed unwritten leaves
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
  const openPage = useOpenArtifactPage();
  const editorRef = useRef<ContentEditorRef>(null);
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  /** Set once the draft is a document, so opening it asks nothing. */
  const created = useRef(false);
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
      openPage(document.id, { replace: true });
    },
  });
  const leavePrompt = useArtifactLeaveGuard({
    dirty: () => dirty && !created.current,
    stays: (next) => next.search.docDraft === true,
  });
  const markEdited = () => {
    setDirty(true);
    if (create.isError) create.reset();
  };
  const save = () => {
    if (!create.isPending) create.mutate();
  };
  return (
    <PaneFrame full={search.docFull}>
      <ArtifactPaneHeader
        title={title.trim() || m.doc_untitled()}
        status={create.isPending ? "saving" : dirty ? "unsaved" : "saved"}
        version={0}
        full={Boolean(search.docFull)}
        onToggleFull={() =>
          navigate({ docFull: search.docFull ? undefined : true }, { replace: true })
        }
        onClose={() => navigate(closedArtifactSearch)}
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
      {(dirty || create.isError) && (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-secondary px-4 py-2.5">
          <span className="min-w-0 flex-1 text-sm text-tertiary">
            {create.isError && m.doc_new_failed()}
          </span>
          <Button size="sm" color="primary" isLoading={create.isPending} onClick={save}>
            {m.doc_save()}
          </Button>
        </footer>
      )}
      {leavePrompt}
    </PaneFrame>
  );
}
