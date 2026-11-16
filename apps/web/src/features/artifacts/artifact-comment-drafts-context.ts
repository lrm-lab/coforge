import { createContext, useContext } from "react";

import type { DraftRefusalReason } from "./artifact-comment-draft-inputs";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";
import type { useCommentDraftsStore } from "./use-comment-drafts";

export type DraftRefusal = { draftId: string; reason: DraftRefusalReason; names: string[] };

export type PendingReview = {
  open: boolean;
  banner: "refused" | "changed" | null;
  refusal: DraftRefusal | null;
};

type Store = ReturnType<typeof useCommentDraftsStore>;

export type CommentDraftsState = Pick<Store, "drafts" | "limit" | "canUndo" | "canRedo"> & {
  busy: boolean;
  submitting: boolean;
  atLimit: boolean;
  loadFailed: boolean;
  pending: PendingReview;
  focus: string | null;
};

export type CommentDraftActions = Pick<
  Store,
  "create" | "edit" | "remove" | "undo" | "redo" | "discardAll"
> & {
  submit(): Promise<void>;
  reload(): void;
  closePending(): void;
  openDraft(draft: CommentDraftView): void;
  consumeFocus(): void;
};

export const CommentDraftsContext = createContext<CommentDraftsState | null>(null);

export const CommentDraftActionsContext = createContext<CommentDraftActions | null>(null);

export function useCommentDrafts(): CommentDraftsState {
  const value = useContext(CommentDraftsContext);
  if (value === null) throw new Error("CommentDraftsContext is missing");
  return value;
}

export function useCommentDraftActions(): CommentDraftActions {
  const value = useContext(CommentDraftActionsContext);
  if (value === null) throw new Error("CommentDraftActionsContext is missing");
  return value;
}
