import type { ActionCardView } from "#src/server/conversations/action-cards.server";
import { loadActionCardStates } from "./action-cards.functions";

/**
 * Refreshes just the pending action cards among the loaded messages (the window's and the open
 * threads'), without re-fetching the whole page: one `loadActionCardStates` call for their ids,
 * each answer written into its message.
 */
export async function refreshPendingActionCards<
  M extends { id: string; actionCard?: ActionCardView },
>(loaded: readonly M[], update: (messageId: string, update: (message: M) => M) => void) {
  const pendingIds = loaded
    .filter((message) => message.actionCard?.state === "pending")
    .map((message) => message.id);
  if (!pendingIds.length) return;
  const states = await loadActionCardStates({ data: { messageIds: pendingIds } });
  for (const [messageId, state] of Object.entries(states))
    update(messageId, (message) => ({ ...message, actionCard: state }));
}
