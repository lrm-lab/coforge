import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import {
  restoredReadFailures,
  restoredReadPaused,
  subscribeRestoredReads,
} from "#src/features/cache-persistence/browser-query-cache";
import { m } from "#src/paraglide/messages";
import { conversationWindowKeys } from "./conversation-queries";

/** Failed reads in a row after which the stream says it could not reach the newest messages: one
 * is often a phone's network not ready yet, and the retry that follows usually lands. */
const FAILURES_SHOWN = 2;

/**
 * Says so when a conversation opened from the browser's stored copy could not read its newest
 * messages (task #253): `FAILURES_SHOWN` reads failed, or the read was parked while the browser
 * was offline and has not landed since. The copy may be days old, and without this it reads as the newest. Its
 * retry reads again at once; the reads also go on by themselves (`followRestoredReads`), and the
 * notice goes as soon as one lands. Nothing shows while a read is merely on its way: Raft opens a
 * channel with no such notice either.
 */
export function ConversationUpdateNotice({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  // The conversation is a channel or a DM; only the one opened has a window in the cache.
  const keys = conversationWindowKeys(conversationId);
  const unreachable = useSyncExternalStore(
    useCallback((listener) => subscribeRestoredReads(queryClient, listener), [queryClient]),
    () =>
      keys.some(
        (key) =>
          restoredReadPaused(queryClient, key) ||
          restoredReadFailures(queryClient, key) >= FAILURES_SHOWN,
      ),
    () => false,
  );
  if (!unreachable) return null;
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
        onPress={() =>
          keys.forEach((queryKey) => void queryClient.invalidateQueries({ queryKey, exact: true }))
        }
      >
        {m.controls_retry()}
      </Button>
    </div>
  );
}
