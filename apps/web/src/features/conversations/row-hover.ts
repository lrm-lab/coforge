import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Whether the pointer is over a whole conversation row, for a face inside it that reacts to that
 * (a Direct-message row's moving mascot). A tiny store rather than state in `ConversationRow`, so
 * hovering a row repaints only the face that reads it, not the row and its text.
 */
export type RowHover = {
  set(hovered: boolean): void;
  subscribe(listener: () => void): () => void;
  get(): boolean;
};

export function createRowHover(): RowHover {
  let hovered = false;
  const listeners = new Set<() => void>();
  return {
    set(next) {
      if (next === hovered) return;
      hovered = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => hovered,
  };
}

export const RowHoverContext = createContext<RowHover | null>(null);

/** Whether the pointer is over the row this face belongs to; false outside a row. */
export function useRowHovered(): boolean {
  const hover = useContext(RowHoverContext);
  return useSyncExternalStore(
    (listener) => hover?.subscribe(listener) ?? (() => {}),
    () => hover?.get() ?? false,
    () => false,
  );
}
