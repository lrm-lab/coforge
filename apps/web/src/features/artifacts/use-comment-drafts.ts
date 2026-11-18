import { useCallback, useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppToast } from "#src/components/ui/toast";
import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { COMMENT_DRAFTS_MAX, type DraftCreateInput } from "./artifact-comment-draft-inputs";
import {
  commentDraftsKey,
  commentDraftsQuery,
  hasImages,
  inCreationOrder,
  type CommentDraftsRead,
  type CommentDraftView,
} from "./artifact-comment-drafts-queries";
import {
  createCommentDraft,
  deleteCommentDraft,
  discardCommentDrafts,
  editCommentDraft,
} from "./artifact-comment-drafts.functions";
import {
  EMPTY_HISTORY,
  historyReducer,
  snapshotOf,
  type DraftStep,
} from "./artifact-draft-history";

export type DraftInput = Omit<DraftCreateInput, "artifactId">;

export type DraftActivity = "idle" | "changing" | "sending";

type Direction = "undo" | "redo";

const NO_DRAFTS: CommentDraftView[] = [];

export const draftFailure = (error: unknown) =>
  isAppError(error) && error.errorId === "artifact-draft-limit"
    ? m.av_dr_limit({ count: Number(error.details?.limit ?? COMMENT_DRAFTS_MAX) })
    : m.av_dr_save_failed();

const refusedForGood = (error: unknown) =>
  isAppError(error) && !isAppErrorCode(error, "TEMPORARILY_UNAVAILABLE", "INTERNAL_ERROR");

export function useCommentDraftsStore(artifactId: string, enabled: boolean, onChanged: () => void) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const read = useQuery({ ...commentDraftsQuery(artifactId), enabled });
  const [history, dispatch] = useReducer(historyReducer, EMPTY_HISTORY);
  const latest = useRef(history);
  latest.current = history;
  const [activity, setActivity] = useState<DraftActivity>("idle");
  const running = useRef(false);
  const drafts = read.data?.drafts ?? NO_DRAFTS;
  const key = commentDraftsKey(artifactId);

  const patch = useCallback(
    (change: (held: CommentDraftView[]) => CommentDraftView[]) => {
      queryClient.setQueryData<CommentDraftsRead>(
        key,
        (data) => data && { ...data, drafts: change(data.drafts) },
      );
      onChanged();
    },
    [queryClient, key, onChanged],
  );

  const insert = useCallback(
    async (input: DraftInput) => {
      const created = await createCommentDraft({ data: { artifactId, ...input } });
      patch((held) =>
        inCreationOrder([...held.filter((draft) => draft.id !== created.id), created]),
      );
      return created;
    },
    [artifactId, patch],
  );
  const change = useCallback(
    async (id: string, body: string) => {
      const edited = await editCommentDraft({ data: { artifactId, draftId: id, body } });
      patch((held) => held.map((draft) => (draft.id === id ? edited : draft)));
    },
    [artifactId, patch],
  );
  const drop = useCallback(
    async (id: string) => {
      await deleteCommentDraft({ data: { artifactId, draftId: id } });
      patch((held) => held.filter((draft) => draft.id !== id));
    },
    [artifactId, patch],
  );
  const recreate = useCallback(
    async (step: Extract<DraftStep, { kind: "create" | "delete" }>) => {
      const created = await insert(step.snapshot);
      dispatch({ type: "rebind", from: step.id, to: created.id });
    },
    [insert],
  );

  const exclusive = useCallback(
    async <T>(kind: Exclude<DraftActivity, "idle">, work: () => Promise<T>): Promise<T> => {
      if (running.current) throw new Error("a draft change or send is running");
      running.current = true;
      setActivity(kind);
      try {
        return await work();
      } finally {
        running.current = false;
        setActivity("idle");
      }
    },
    [],
  );

  const create = useCallback(
    (input: DraftInput) =>
      exclusive("changing", async () => {
        const created = await insert(input);
        if (!hasImages(created))
          dispatch({
            type: "record",
            step: {
              key: crypto.randomUUID(),
              kind: "create",
              id: created.id,
              snapshot: snapshotOf(created),
            },
          });
        return created;
      }),
    [exclusive, insert],
  );
  const edit = useCallback(
    (draft: CommentDraftView, body: string) =>
      exclusive("changing", async () => {
        await change(draft.id, body);
        if (!hasImages(draft))
          dispatch({
            type: "record",
            step: {
              key: crypto.randomUUID(),
              kind: "edit",
              id: draft.id,
              from: draft.body,
              to: body,
            },
          });
      }),
    [exclusive, change],
  );

  const restoreFromToast = useCallback(
    async (stepKey: string) => {
      const step = latest.current.past.find((held) => held.key === stepKey);
      if (!step || step.kind !== "delete") return;
      if (running.current) throw new Error("another change is running");
      await exclusive("changing", async () => {
        await recreate(step);
        dispatch({ type: "drop", key: stepKey });
      });
    },
    [exclusive, recreate],
  );
  const remove = useCallback(
    (draft: CommentDraftView) =>
      exclusive("changing", async () => {
        await drop(draft.id);
        if (hasImages(draft)) return;
        const stepKey = crypto.randomUUID();
        dispatch({
          type: "record",
          step: { key: stepKey, kind: "delete", id: draft.id, snapshot: snapshotOf(draft) },
        });
        toast.undoable(m.av_dr_deleted(), {
          key: draft.id,
          failed: m.av_dr_undo_failed(),
          onUndo: () => restoreFromToast(stepKey),
        });
      }),
    [exclusive, drop, toast, restoreFromToast],
  );
  const discardAll = useCallback(
    () =>
      exclusive("changing", async () => {
        await discardCommentDrafts({ data: { artifactId } });
        dispatch({ type: "clear" });
        patch(() => []);
      }),
    [exclusive, artifactId, patch],
  );

  const replay = useCallback(
    async (step: DraftStep, direction: Direction) => {
      const forward = direction === "redo";
      if (step.kind === "edit") return change(step.id, forward ? step.to : step.from);
      if ((step.kind === "create") === forward) return recreate(step);
      return drop(step.id);
    },
    [change, drop, recreate],
  );
  const travel = useCallback(
    (direction: Direction) => {
      const step = (direction === "undo" ? latest.current.past : latest.current.future).at(-1);
      if (!step || running.current) return false;
      void exclusive("changing", async () => {
        await replay(step, direction);
        dispatch({ type: direction === "undo" ? "undone" : "redone", key: step.key });
      }).catch((error: unknown) => {
        toast.error(direction === "undo" ? m.av_dr_undo_failed() : m.av_dr_redo_failed());
        if (refusedForGood(error)) dispatch({ type: "drop", key: step.key });
      });
      return true;
    },
    [exclusive, replay, toast],
  );
  const undo = useCallback(() => travel("undo"), [travel]);
  const redo = useCallback(() => travel("redo"), [travel]);
  const clearHistory = useCallback(() => dispatch({ type: "clear" }), []);

  return {
    read,
    drafts,
    limit: read.data?.limit ?? COMMENT_DRAFTS_MAX,
    activity,
    exclusive,
    create,
    edit,
    remove,
    discardAll,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    historyHeld: history.past.length > 0 || history.future.length > 0,
    clearHistory,
  };
}
