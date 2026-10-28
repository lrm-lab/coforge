import { useEffect, useMemo, useRef } from "react";

import { composerDraftKey } from "./composer-draft";
import { useMessageOutbox, useOutboxEntries } from "./use-message-outbox";

/**
 * A conversation pane's outbox: the viewer's messages the server has not confirmed yet (or failed
 * to take), and which of them the pane shows at the foot of its stream until the real message is
 * loaded. A thread pane (`rootId`) keeps its own.
 */
export function usePaneOutbox({
  conversation,
  rootId,
  onSend,
  onSent,
  onNewSend,
}: {
  conversation: { conversationId: string; hasNewer?: boolean; messages: readonly { id: string }[] };
  rootId?: string;
  onSend: Parameters<typeof useMessageOutbox>[0]["onSend"];
  onSent?: Parameters<typeof useMessageOutbox>[0]["onSent"];
  /** A new send started: the pane brings its latest messages into view. */
  onNewSend: () => void;
}) {
  const outboxDraftKey = composerDraftKey(conversation.conversationId, rootId);
  const outbox = useMessageOutbox({ draftKey: outboxDraftKey, onSend, onSent });
  const outboxEntries = useOutboxEntries(outboxDraftKey);
  const loadedMessageIds = useMemo(
    () => new Set(conversation.messages.map((message) => message.id)),
    [conversation.messages],
  );
  // Keep delivered entries until the real row is loaded; always show failures.
  const windowAtLatest = Boolean(rootId) || !conversation.hasNewer;
  const shownOutbox = outboxEntries.filter((entry) =>
    entry.state === "unsent"
      ? true
      : windowAtLatest && (entry.state === "sending" || !loadedMessageIds.has(entry.messageId)),
  );
  useEffect(() => {
    for (const entry of outboxEntries)
      if (entry.state === "delivered" && loadedMessageIds.has(entry.messageId))
        outbox.discard(entry);
  }, [outboxEntries, loadedMessageIds]);
  // Only new sends scroll the pane to its latest messages.
  const knownOutboxIdsRef = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    const known = knownOutboxIdsRef.current;
    knownOutboxIdsRef.current = new Set(outboxEntries.map((entry) => entry.localId));
    if (!known) return;
    if (!outboxEntries.some((entry) => entry.state === "sending" && !known.has(entry.localId)))
      return;
    onNewSend();
  }, [outboxEntries]);
  return { outbox, outboxEntries, outboxDraftKey, shownOutbox };
}
