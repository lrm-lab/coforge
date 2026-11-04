import type { Draft } from "./action-card-question-rows";

/**
 * A questions card's half-given answers, kept for the page's life by the card's message (Raft,
 * task #515): the card is drawn afresh when the layout turns from desktop to phone, or the channel
 * is left and opened again, and several questions are too much to answer twice. Nothing goes to the
 * server; a reload starts over.
 */
const kept = new Map<string, Record<string, Draft>>();

export function keptDrafts(messageId: string): Record<string, Draft> {
  return kept.get(messageId) ?? {};
}

export function keepDrafts(messageId: string, drafts: Record<string, Draft>) {
  if (Object.keys(drafts).length) kept.set(messageId, drafts);
  else kept.delete(messageId);
}

/** The card is answered or closed: nothing left to keep. */
export function dropDrafts(messageId: string) {
  kept.delete(messageId);
}
