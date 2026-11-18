import { useCallback, useSyncExternalStore } from "react";

import type { PiChatDraft } from "./pi-chat-state";

const EMPTY_DRAFT: PiChatDraft = Object.freeze({ text: "" });

export type PiChatDrafts = {
  get(key: string): PiChatDraft;
  set(key: string, draft: PiChatDraft): void;
  update(key: string, change: (draft: PiChatDraft) => PiChatDraft): void;
  clear(key: string): void;
  subscribe(key: string, listener: () => void): () => void;
};

export function createPiChatDrafts(): PiChatDrafts {
  const drafts = new Map<string, PiChatDraft>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const store: PiChatDrafts = {
    get: (key) => drafts.get(key) ?? EMPTY_DRAFT,
    set(key, draft) {
      drafts.set(key, draft);
      notify(key);
    },
    update: (key, change) => store.set(key, change(store.get(key))),
    clear(key) {
      drafts.delete(key);
      notify(key);
    },
    subscribe(key, listener) {
      const keyed = listeners.get(key) ?? new Set();
      keyed.add(listener);
      listeners.set(key, keyed);
      return () => {
        keyed.delete(listener);
        if (keyed.size === 0) listeners.delete(key);
      };
    },
  };
  return store;
}

export function usePiChatDraft(drafts: PiChatDrafts, key: string): PiChatDraft {
  const subscribe = useCallback(
    (listener: () => void) => drafts.subscribe(key, listener),
    [drafts, key],
  );
  const read = () => drafts.get(key);
  return useSyncExternalStore(subscribe, read, read);
}
