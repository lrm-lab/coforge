import { useCallback, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAppToast } from "#src/components/ui/toast";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { PendingReview } from "./artifact-comment-drafts-context";
import { commentDraftsKey, type CommentDraftView } from "./artifact-comment-drafts-queries";
import { submitCommentDrafts } from "./artifact-comment-drafts.functions";
import { syncOwnComments } from "./artifact-comment-queries";
import type { useCommentDraftsStore } from "./use-comment-drafts";

export const PENDING_CLOSED: PendingReview = { open: false, banner: null, refusal: null };

const DEFINITE_REFUSALS = new Set(["artifact-drafts-changed", "artifact-idempotency-mismatch"]);

export function useSubmitDrafts({
  artifactId,
  store,
  clientKey,
  renewKey,
  openPanel,
  openThread,
}: {
  artifactId: string;
  store: ReturnType<typeof useCommentDraftsStore>;
  clientKey: RefObject<string>;
  renewKey: () => void;
  openPanel: () => void;
  openThread: (commentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const [pending, setPending] = useState<PendingReview>(PENDING_CLOSED);
  const shown = useRef<readonly CommentDraftView[]>(store.drafts);
  shown.current = store.drafts;
  const { exclusive, clearHistory } = store;
  const { refetch } = store.read;

  const closePending = useCallback(() => setPending(PENDING_CLOSED), []);
  const clearFlag = useCallback(
    (draftId: string) =>
      setPending((held) =>
        held.refusal?.draftId === draftId ? { ...held, banner: null, refusal: null } : held,
      ),
    [],
  );

  const send = useCallback(
    async (draftIds: string[]) => {
      try {
        const result = await submitCommentDrafts({
          data: { artifactId, draftIds, clientKey: clientKey.current },
        });
        renewKey();
        if (result.status === "rejected") {
          setPending({
            open: true,
            banner: "refused",
            refusal: { draftId: result.draftId, reason: result.reason, names: result.names ?? [] },
          });
          openPanel();
          return;
        }
        clearHistory();
        queryClient.setQueryData(commentDraftsKey(artifactId), (data: unknown) =>
          data && typeof data === "object" ? { ...data, drafts: [] } : data,
        );
        setPending(PENDING_CLOSED);
        toast.success(m.av_dr_sent({ count: result.commentIds.length }));
        await syncOwnComments(queryClient, artifactId, "posted", result.commentIds);
        const first = result.commentIds[0];
        if (first) openThread(first);
      } catch (error) {
        const errorId = isAppError(error) ? error.errorId : undefined;
        if (errorId && DEFINITE_REFUSALS.has(errorId)) {
          renewKey();
          await refetch();
          if (errorId === "artifact-drafts-changed") {
            setPending({ open: true, banner: "changed", refusal: null });
            openPanel();
          } else toast.error(m.av_dr_send_failed());
        } else toast.error(m.av_dr_send_failed());
      }
    },
    [
      artifactId,
      clientKey,
      renewKey,
      clearHistory,
      queryClient,
      toast,
      openPanel,
      openThread,
      refetch,
    ],
  );
  const submit = useCallback(async () => {
    const cached = queryClient.getQueryData<{ drafts?: readonly CommentDraftView[] }>(
      commentDraftsKey(artifactId),
    )?.drafts;
    const draftIds = (cached ?? shown.current).map(({ id }) => id);
    if (draftIds.length === 0) return;
    await exclusive("sending", () => send(draftIds)).catch(() => undefined);
  }, [artifactId, exclusive, queryClient, send]);

  return { pending, closePending, clearFlag, submit };
}
