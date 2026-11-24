import type { PendingAttachment } from "./composer-attachments";

const NONE: readonly PendingAttachment[] = [];
const drafts = new Map<string, readonly PendingAttachment[]>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Map<string, AbortController>();
const removed = new Set<string>();

export function draftAttachments(key: string): readonly PendingAttachment[] {
  return drafts.get(key) ?? NONE;
}

export function updateDraftAttachments(
  key: string,
  update: (current: readonly PendingAttachment[]) => readonly PendingAttachment[],
): void {
  const current = draftAttachments(key);
  const next = update(current);
  if (next === current) return;
  if (next.length) drafts.set(key, next);
  else drafts.delete(key);
  for (const listener of listeners.get(key) ?? []) listener();
}

export function subscribeDraftAttachments(key: string, listener: () => void): () => void {
  const forKey = listeners.get(key) ?? new Set();
  listeners.set(key, forKey);
  forKey.add(listener);
  return () => {
    forKey.delete(listener);
    if (forKey.size === 0) listeners.delete(key);
  };
}

export function startUpload(localId: string): AbortSignal {
  const controller = new AbortController();
  inFlight.set(localId, controller);
  return controller.signal;
}

export function finishUpload(localId: string): void {
  inFlight.delete(localId);
}

export function wasRemoved(localId: string): boolean {
  return removed.has(localId);
}

export function removeDraftAttachments(key: string, localIds: readonly string[]): void {
  const removedIds = new Set(localIds);
  for (const id of removedIds) {
    removed.add(id);
    inFlight.get(id)?.abort();
  }
  updateDraftAttachments(key, (current) => current.filter((item) => !removedIds.has(item.localId)));
}
