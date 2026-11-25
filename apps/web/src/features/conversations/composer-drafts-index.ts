import { browserLocalStorage } from "#src/features/browser-local-storage";
import {
  observeComposerDrafts,
  placeOfDraftKey,
  retainDraftStorageBridge,
  stampKey,
  type DraftPlace,
} from "./composer-draft";

export type DeviceDraft = {
  key: string;
  place: DraftPlace;
  body: string;
  updatedAt: number | null;
};

function compareDrafts(left: DeviceDraft, right: DeviceDraft): number {
  return (
    (right.updatedAt ?? -1) - (left.updatedAt ?? -1) ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  );
}

function readDraft(storage: Storage, key: string, place: DraftPlace): DeviceDraft | undefined {
  const body = storage.getItem(key);
  if (!body?.trim()) return undefined;
  const stamp = Number(storage.getItem(stampKey(key)));
  return { key, place, body, updatedAt: stamp > 0 && Number.isFinite(stamp) ? stamp : null };
}

export function listComposerDrafts(): DeviceDraft[] {
  const storage = browserLocalStorage();
  if (!storage) return [];
  const drafts: DeviceDraft[] = [];
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      const place = key === null ? undefined : placeOfDraftKey(key);
      const draft = key === null || !place ? undefined : readDraft(storage, key, place);
      if (draft) drafts.push(draft);
    }
  } catch {}
  return drafts.sort(compareDrafts);
}

function withDraft(
  drafts: readonly DeviceDraft[],
  key: string,
): { drafts: DeviceDraft[]; current: DeviceDraft | undefined; place: DraftPlace | undefined } {
  const place = placeOfDraftKey(key);
  const storage = browserLocalStorage();
  let current: DeviceDraft | undefined;
  try {
    current = place && storage ? readDraft(storage, key, place) : undefined;
  } catch {}
  const others = drafts.filter((draft) => draft.key !== key);
  if (!current) return { drafts: others, current, place };
  const at = others.findIndex((draft) => compareDrafts(current, draft) < 0);
  return {
    drafts: at < 0 ? [...others, current] : [...others.slice(0, at), current, ...others.slice(at)],
    current,
    place,
  };
}

let cached: DeviceDraft[] | undefined;
let conversationDraftKeys: Map<string, Set<string>> | undefined;
const conversationListeners = new Map<string, Set<() => void>>();
let releaseConversationBridge: (() => void) | undefined;

function buildConversationDraftKeys(drafts: readonly DeviceDraft[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const draft of drafts) {
    if (draft.place.target.kind === "task") continue;
    const keys = index.get(draft.place.conversationId) ?? new Set<string>();
    keys.add(draft.key);
    index.set(draft.place.conversationId, keys);
  }
  return index;
}

function notifyConversation(conversationId: string): void {
  const listeners = conversationListeners.get(conversationId);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

function notifyAllConversations(): void {
  for (const listeners of conversationListeners.values()) {
    for (const listener of listeners) listener();
  }
}

observeComposerDrafts((change, notify) => {
  if (change === null) {
    cached = undefined;
    conversationDraftKeys = undefined;
    if (notify) notifyAllConversations();
    return;
  }
  if (!cached) {
    conversationDraftKeys = undefined;
    if (notify) {
      const place = placeOfDraftKey(change);
      if (place && place.target.kind !== "task") notifyConversation(place.conversationId);
    }
    return;
  }
  const updated = withDraft(cached, change);
  cached = updated.drafts;
  const place = updated.place;
  if (!place || place.target.kind === "task") return;
  const conversationId = place.conversationId;
  let flipped = true;
  if (conversationDraftKeys) {
    const existing = conversationDraftKeys.get(conversationId);
    const hadBefore = (existing?.size ?? 0) > 0;
    if (updated.current) {
      if (existing) existing.add(change);
      else conversationDraftKeys.set(conversationId, new Set([change]));
    } else if (existing) {
      existing.delete(change);
      if (existing.size === 0) conversationDraftKeys.delete(conversationId);
    }
    const hasAfter = (conversationDraftKeys.get(conversationId)?.size ?? 0) > 0;
    flipped = hadBefore !== hasAfter;
  }
  if (notify && flipped) notifyConversation(conversationId);
});

export function deviceDrafts(): DeviceDraft[] {
  return (cached ??= listComposerDrafts());
}

export function hasConversationDraft(conversationId: string): boolean {
  if (!conversationDraftKeys) {
    conversationDraftKeys = buildConversationDraftKeys(deviceDrafts());
  }
  return (conversationDraftKeys.get(conversationId)?.size ?? 0) > 0;
}

export function subscribeConversationDraft(
  conversationId: string,
  listener: () => void,
): () => void {
  const wasEmpty = conversationListeners.size === 0;
  let listeners = conversationListeners.get(conversationId);
  if (!listeners) {
    listeners = new Set();
    conversationListeners.set(conversationId, listeners);
  }
  listeners.add(listener);
  if (wasEmpty) releaseConversationBridge = retainDraftStorageBridge();
  return () => {
    const current = conversationListeners.get(conversationId);
    if (!current?.delete(listener)) return;
    if (current.size === 0) conversationListeners.delete(conversationId);
    if (conversationListeners.size === 0) {
      const release = releaseConversationBridge;
      releaseConversationBridge = undefined;
      release?.();
    }
  };
}
