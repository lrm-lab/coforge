import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";

/** What an unread read left out because the Agent was already shown it. */
export type FoldedMessages = Readonly<{
  count: number;
  fromSequence: number;
  throughSequence: number;
}>;

/**
 * Splits an unread page into the messages the Agent has not been shown and a summary of those it
 * has. "Shown" is the daemon's own account of what reached the model (its contiguous frontier and
 * the messages shown one by one above it), not the server's read-through. Decided before the read
 * is recorded, since recording it would make every message on the page look shown.
 */
export function foldShownMessages<T extends { target: string; sequence: number }>(
  attention: Pick<AgentMessageAttentionIndex, "hasSeen" | "resolveTarget">,
  agentId: string,
  target: string,
  messages: readonly T[],
): { messages: T[]; folded?: FoldedMessages } {
  const canonical = attention.resolveTarget(agentId, target);
  const isShown = (message: T) =>
    message.target === canonical && attention.hasSeen(agentId, canonical, message.sequence);
  const shown = messages.filter(isShown);
  const fresh = messages.filter((message) => !isShown(message));
  if (shown.length === 0) return { messages: fresh };
  return {
    messages: fresh,
    folded: {
      count: shown.length,
      fromSequence: shown[0]!.sequence,
      throughSequence: shown.at(-1)!.sequence,
    },
  };
}
