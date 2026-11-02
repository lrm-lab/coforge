import { useCallback, useSyncExternalStore } from "react";
import { onlineManager, useQueryClient } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import {
  restoredCopyShown,
  subscribeRestoredReads,
} from "#src/features/cache-persistence/browser-query-cache";
import { m } from "#src/paraglide/messages";
import { conversationWindowKeys } from "./conversation-queries";

/** Failed reads in a row after which the stream says it could not reach the newest messages: one
 * is often a phone's network not ready yet, and the retry that follows usually lands. */
const FAILURES_SHOWN = 2;

const subscribeOnline = (listener: () => void) => onlineManager.subscribe(listener);
const isOnline = () => onlineManager.isOnline();

/**
 * Says so when the conversation on screen cannot read its newest messages (task #253), whether
 * its messages came from the browser's stored copy or from this page's memory: the copy may be
 * a day old, and without this it reads as the newest. It shows while the stored copy is still on
 * screen (`followRestoredReads`) and its read failed `FAILURES_SHOWN` times in a row or waits for
 * the network (TanStack's own `fetchFailureCount` and `paused`), when the catch-up
 * of this open failed `FAILURES_SHOWN` times, or while the browser is offline and the catch-up has
 * not landed yet (offline, nothing reads it until the network returns). Its retry reads again at
 * once; the reads also go on by themselves, and the notice goes as soon as one lands. Nothing
 * shows while a read is merely on its way: Raft opens a channel with no such notice either.
 */
export function ConversationUpdateNotice({
  conversation: { conversationId, caughtUp = true, catchUpFailures = 0, retryCatchUp },
}: {
  conversation: {
    conversationId: string;
    /** A catch-up has landed since this open (`createConversationReconciler`). */
    caughtUp?: boolean;
    /** Catch-ups of this open that failed in a row. */
    catchUpFailures?: number;
    /** Reads what arrived at once, the wait of a failed catch-up dropped. */
    retryCatchUp?: () => void;
  };
}) {
  const queryClient = useQueryClient();
  // The conversation is a channel or a DM; only the one opened has a window in the cache.
  const keys = conversationWindowKeys(conversationId);
  const restoredUnreachable = useSyncExternalStore(
    useCallback(
      (listener) => {
        const stopReads = subscribeRestoredReads(queryClient, listener);
        const stopCache = queryClient.getQueryCache().subscribe(listener);
        return () => {
          stopReads();
          stopCache();
        };
      },
      [queryClient],
    ),
    () =>
      keys.some((key) => {
        if (!restoredCopyShown(queryClient, key)) return false;
        const state = queryClient.getQueryState(key);
        return state?.fetchStatus === "paused" || (state?.fetchFailureCount ?? 0) >= FAILURES_SHOWN;
      }),
    () => false,
  );
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const catchUpFailing = catchUpFailures >= FAILURES_SHOWN || (!caughtUp && !online);
  if (!restoredUnreachable && !catchUpFailing) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 px-4 pb-1 text-xs text-tertiary md:px-6"
    >
      {m.conversation_load_latest_failed()}
      <Button
        size="sm"
        color="link-color"
        className="text-xs"
        onPress={() => {
          keys.forEach((queryKey) => void queryClient.invalidateQueries({ queryKey, exact: true }));
          retryCatchUp?.();
        }}
      >
        {m.controls_retry()}
      </Button>
    </div>
  );
}
