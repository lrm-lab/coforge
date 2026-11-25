/**
 * Per-chat message-composer drafts, kept on this device only.
 *
 * Each chat (and each thread inside it) gets its own `localStorage` entry, so
 * typing in one conversation never leaks into another and an unfinished text
 * survives switching chats, reloads, and restarts on the same device.
 * Attachments are intentionally not persisted: files cannot live in
 * `localStorage`, so only the text body is remembered. The people the text's `@name`s were
 * picked to mean (`MentionPin`) are remembered too, beside it under their own key, so a reload
 * keeps who was meant along with what was written. A draft's last edit is remembered beside it
 * too (`stampKey`), so the Drafts page can list the newest first.
 *
 * This file owns the key format (the builders and `placeOfDraftKey`, their inverse) and the one
 * way to hear of a change (`subscribeComposerDrafts`, which says which draft's key changed); the
 * Drafts list itself is `composer-drafts-index.ts`.
 */

import { browserLocalStorage } from "#src/features/browser-local-storage";
import { isMentionPin, NO_PINS, type MentionPin } from "./mention-pins";

const DRAFT_KEY_PREFIX = "coforge.composer-draft:";

/** Which part of a conversation a draft was written in: its main composer, one thread's, or a
 * Task's discussion. */
export type DraftTarget =
  | { kind: "conversation" }
  | { kind: "thread"; threadRootId: string }
  | { kind: "task"; number: number };

/** Where a draft was written: a conversation, and which part of it. For a Task, `conversationId`
 * is its board's. */
export type DraftPlace = { conversationId: string; target: DraftTarget };

/** Where a draft's last-edit time (epoch ms) lives: beside its text, under the same key. */
export function stampKey(draftKey: string): string {
  return `${draftKey}:at`;
}

/** Storage key for one composer: the main pane, or one thread pane. */
export function composerDraftKey(conversationId: string, threadRootId?: string): string {
  return threadRootId
    ? `${DRAFT_KEY_PREFIX}${conversationId}:thread:${threadRootId}`
    : `${DRAFT_KEY_PREFIX}${conversationId}`;
}

/** Storage key for a Task's discussion composer, under the Task's board and number. */
export function taskDraftKey(boardConversationId: string, number: number): string {
  return `${DRAFT_KEY_PREFIX}task:${boardConversationId}:${number}`;
}

/**
 * The place a storage key's draft belongs to, the inverse of the builders above; `undefined` for
 * any other key. A draft's `:pins` and `:at` siblings and a file's comment draft
 * (`attachmentCommentDraftKey`) have other shapes, so they are not drafts here.
 */
export function placeOfDraftKey(key: string): DraftPlace | undefined {
  if (!key.startsWith(DRAFT_KEY_PREFIX)) return undefined;
  const parts = key.slice(DRAFT_KEY_PREFIX.length).split(":");
  if (parts.some((part) => part === "")) return undefined;
  const [first, second, third] = parts as [string, string?, string?];
  if (parts.length === 1) return { conversationId: first, target: { kind: "conversation" } };
  if (parts.length !== 3) return undefined;
  if (first === "task" && /^[1-9]\d*$/.test(third!))
    return { conversationId: second!, target: { kind: "task", number: Number(third) } };
  if (second === "thread")
    return { conversationId: first, target: { kind: "thread", threadRootId: third! } };
  return undefined;
}

export type DraftChange = string | null;
type DraftObserver = (change: DraftChange, notify: boolean) => void;
type DraftListener = (change: DraftChange) => void;

const listeners = new Set<DraftListener>();
const observers = new Set<DraftObserver>();
let bridgeRetainers = 0;
let releaseListenersBridge: (() => void) | undefined;

export function observeComposerDrafts(observer: DraftObserver): () => void {
  observers.add(observer);
  return () => void observers.delete(observer);
}

function draftsChanged(change: DraftChange, notify: boolean = true): void {
  for (const observer of observers) observer(change, notify);
  if (notify) for (const listener of listeners) listener(change);
}

function onStorageEvent(event: { key: string | null }): void {
  if (event.key === null || placeOfDraftKey(event.key)) draftsChanged(event.key);
}

function canListen(): boolean {
  return typeof window !== "undefined" && typeof window.addEventListener === "function";
}

export function retainDraftStorageBridge(): () => void {
  bridgeRetainers += 1;
  if (bridgeRetainers === 1) {
    draftsChanged(null, false);
    if (canListen()) window.addEventListener("storage", onStorageEvent);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    bridgeRetainers -= 1;
    if (bridgeRetainers === 0 && canListen()) {
      window.removeEventListener("storage", onStorageEvent);
    }
  };
}

export function subscribeComposerDrafts(listener: DraftListener): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) releaseListenersBridge = retainDraftStorageBridge();
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    const release = releaseListenersBridge;
    releaseListenersBridge = undefined;
    release?.();
  };
}

/** Storage key for a file's comment field (`useCommentDraft`): one per file, never a conversation's
 * (whose keys are ids). */
export function attachmentCommentDraftKey(attachmentId: string): string {
  return `${DRAFT_KEY_PREFIX}attachment-comments:${attachmentId}`;
}

/** The saved draft text, or `""` when none exists or storage is unavailable. */
export function readComposerDraft(key: string): string {
  const storage = browserLocalStorage();
  if (!storage) return "";
  try {
    return storage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/**
 * Saves a draft; a blank body removes the entry so dead chats leave no clutter. The edit time
 * (`now`) is stamped only when the text differs from what is stored: the composer writes the body
 * it just read on every mount, and opening a chat must not move its draft up the list.
 */
export function writeComposerDraft(key: string, body: string, now: number = Date.now()): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  let changed = false;
  try {
    const stored = storage.getItem(key);
    if (body && stored !== body) {
      storage.setItem(key, body);
      // The text is stored: tell even if the stamp then cannot be (quota).
      changed = true;
      storage.setItem(stampKey(key), String(now));
    } else if (!body && stored !== null) {
      storage.removeItem(key);
      changed = true;
      storage.removeItem(stampKey(key));
    }
  } catch {
    // Private mode or quota: the composer still works for this visit.
  }
  if (changed && placeOfDraftKey(key)) draftsChanged(key);
}

/** Where a draft's pins live: beside its text, under the same chat (and thread) key. */
function pinsKey(draftKey: string): string {
  return `${draftKey}:pins`;
}

/** The saved draft's mention pins, or none when there are none, they cannot be read, or storage is
 * unavailable. */
export function readComposerDraftPins(key: string): readonly MentionPin[] {
  const storage = browserLocalStorage();
  if (!storage) return NO_PINS;
  try {
    const raw = storage.getItem(pinsKey(key));
    const parsed: unknown = raw ? JSON.parse(raw) : NO_PINS;
    return Array.isArray(parsed) && parsed.length && parsed.every(isMentionPin) ? parsed : NO_PINS;
  } catch {
    return NO_PINS;
  }
}

/** Saves a draft's mention pins; none removes the entry. */
export function writeComposerDraftPins(key: string, pins: readonly MentionPin[]): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  try {
    if (pins.length) storage.setItem(pinsKey(key), JSON.stringify(pins));
    else storage.removeItem(pinsKey(key));
  } catch {
    // Private mode or quota: the composer still works for this visit.
  }
}

/** Drops the saved draft, its pins and its edit time, e.g. after its message was sent. */
export function clearComposerDraft(key: string): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  let changed = false;
  try {
    changed = storage.getItem(key) !== null;
    storage.removeItem(key);
    storage.removeItem(pinsKey(key));
    storage.removeItem(stampKey(key));
  } catch {
    // Ignore: nothing durable depends on the removal.
  }
  if (changed && placeOfDraftKey(key)) draftsChanged(key);
}
