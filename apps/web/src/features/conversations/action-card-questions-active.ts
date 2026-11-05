import { useSyncExternalStore } from "react";

/**
 * Which questions card ← → turn when focus is not in one (Frank, 11-05: "如果出现多个 question
 * 卡片，左右你怎么知道操作哪个卡片呢？"): the last one the pointer entered or focus moved into. One
 * card at a time is active, and only it shows the ← → hint, so the keys never move a card the
 * person is not looking at.
 */
let active: symbol | null = null;
const listeners = new Set<() => void>();

export function setActiveQuestionsCard(card: symbol | null) {
  if (active === card) return;
  active = card;
  for (const listener of listeners) listener();
}

/** Clears the active card only if it is this one: leaving a card another already took is a no-op. */
export function releaseQuestionsCard(card: symbol) {
  if (active === card) setActiveQuestionsCard(null);
}

export function useIsActiveQuestionsCard(card: symbol) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => active === card,
    () => false,
  );
}

/** A key typed where text goes keeps its arrows for the caret: the message box, a card's own
 * words, any field. */
export function isTextEntry(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable)
  );
}
