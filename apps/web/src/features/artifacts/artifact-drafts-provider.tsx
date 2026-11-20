import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { useArtifactCommenting } from "./artifact-commenting";
import {
  CommentDraftActionsContext,
  CommentDraftsContext,
  type CommentDraftActions,
  type CommentDraftsState,
} from "./artifact-comment-drafts-context";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";
import { useCommentDraftsStore } from "./use-comment-drafts";
import { useDraftUndoKeys } from "./use-draft-undo-keys";
import { useSubmitDrafts } from "./use-submit-drafts";

export function ArtifactDraftsProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const { artifactId, openPanel, openThread } = useArtifactCommenting();
  const clientKey = useRef(crypto.randomUUID());
  const [focus, setFocus] = useState<string | null>(null);
  const renewKey = useCallback(() => {
    clientKey.current = crypto.randomUUID();
  }, []);
  const store = useCommentDraftsStore(artifactId, enabled, renewKey);
  const review = useSubmitDrafts({ artifactId, store, clientKey, renewKey, openPanel, openThread });
  const { drafts, limit, activity, canUndo, canRedo, historyHeld, read } = store;
  const { clearFlag, closePending, submit, pending } = review;
  const { create, edit, remove, discardAll, undo, redo } = store;
  const { refetch } = read;

  useDraftUndoKeys({ enabled: drafts.length > 0 || historyHeld, undo, redo });

  const actions = useMemo<CommentDraftActions>(
    () => ({
      create,
      edit: async (draft, body, editPatch) => {
        await edit(draft, body, editPatch);
        clearFlag(draft.id);
      },
      remove: async (draft) => {
        await remove(draft);
        clearFlag(draft.id);
      },
      discardAll: async () => {
        await discardAll();
        closePending();
      },
      undo,
      redo,
      submit,
      reload: () => void refetch(),
      closePending,
      openDraft: (draft: CommentDraftView) => {
        openPanel();
        setFocus(draft.id);
      },
      consumeFocus: () => setFocus(null),
    }),
    [
      create,
      edit,
      remove,
      discardAll,
      undo,
      redo,
      submit,
      refetch,
      clearFlag,
      closePending,
      openPanel,
    ],
  );
  const state = useMemo<CommentDraftsState>(
    () => ({
      drafts,
      limit,
      canUndo,
      canRedo,
      busy: activity !== "idle",
      submitting: activity === "sending",
      atLimit: drafts.length >= limit,
      loadFailed: read.isError,
      pending,
      focus,
    }),
    [drafts, limit, canUndo, canRedo, activity, read.isError, pending, focus],
  );
  return (
    <CommentDraftActionsContext.Provider value={actions}>
      <CommentDraftsContext.Provider value={state}>{children}</CommentDraftsContext.Provider>
    </CommentDraftActionsContext.Provider>
  );
}
