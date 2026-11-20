import type { DraftCreateInput } from "./artifact-comment-draft-inputs";
import type { CommentAnchor } from "./artifact-comment-inputs";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";

export const DRAFT_HISTORY_MAX = 60;

export type DraftSnapshot = Omit<DraftCreateInput, "artifactId" | "images">;

export type DraftEditPatch = {
  anchor?: CommentAnchor | null;
  path?: string | null;
};

export type DraftStep = { key: string } & (
  | { kind: "create" | "delete"; id: string; snapshot: DraftSnapshot }
  | {
      kind: "edit";
      id: string;
      from: string;
      to: string;
      fromAnchor?: CommentAnchor | null;
      toAnchor?: CommentAnchor | null;
      fromPath?: string | null;
      toPath?: string | null;
    }
);

export type DraftHistory = { past: readonly DraftStep[]; future: readonly DraftStep[] };

export const EMPTY_HISTORY: DraftHistory = { past: [], future: [] };

export type HistoryAction =
  | { type: "record"; step: DraftStep }
  | { type: "undone" | "redone" | "drop"; key: string }
  | { type: "rebind"; from: string; to: string }
  | { type: "clear" };

export function snapshotOf(draft: CommentDraftView): DraftSnapshot {
  return {
    version: draft.version,
    body: draft.body,
    createdAt: new Date(draft.createdAt),
    ...(draft.path === null ? {} : { path: draft.path }),
    ...(draft.anchor === null ? {} : { anchor: draft.anchor }),
    ...(draft.replyTo === null ? {} : { replyTo: draft.replyTo }),
  };
}

const without = (steps: readonly DraftStep[], key: string) =>
  steps.filter((step) => step.key !== key);

export function historyReducer(history: DraftHistory, action: HistoryAction): DraftHistory {
  switch (action.type) {
    case "record":
      return { past: [...history.past, action.step].slice(-DRAFT_HISTORY_MAX), future: [] };
    case "undone": {
      const step = history.past.find(({ key }) => key === action.key);
      return step
        ? { past: without(history.past, action.key), future: [...history.future, step] }
        : history;
    }
    case "redone": {
      const step = history.future.find(({ key }) => key === action.key);
      return step
        ? { past: [...history.past, step], future: without(history.future, action.key) }
        : history;
    }
    case "drop":
      return {
        past: without(history.past, action.key),
        future: without(history.future, action.key),
      };
    case "rebind": {
      const rebind = (step: DraftStep): DraftStep =>
        step.id === action.from ? { ...step, id: action.to } : step;
      return { past: history.past.map(rebind), future: history.future.map(rebind) };
    }
    case "clear":
      return EMPTY_HISTORY;
  }
}
