/**
 * A question card's half-given answers, kept on this device only (Frank, 11-12: local for now,
 * synced across devices later): the dock can be closed, the channel left, the page reloaded, and
 * the answers are still there. One `localStorage` entry per card, `coforge.question-draft:<message
 * id>`, holding `{ at, drafts }`; a card that is answered, declined or expired drops its entry, and
 * an entry older than the longest a card waits is cleared on the first read of a page's life.
 *
 * Read through `readQuestionDrafts` (a cached, stable snapshot for `useSyncExternalStore`) and
 * heard of through `subscribeQuestionDrafts`, which another tab's write reaches too.
 */

import { browserLocalStorage } from "#src/features/browser-local-storage";
import type { Draft, Drafts } from "./question-card-model";

const KEY_PREFIX = "coforge.question-draft:";

/** The longest a card waits for its answer (30 days), and a day's margin. */
export const QUESTION_DRAFT_TTL_MS = 31 * 24 * 60 * 60 * 1_000;

const NONE: Drafts = Object.freeze({}) as Drafts;
const cache = new Map<string, Drafts>();
/** Each card's listeners, so a keystroke in one card's draft calls only that card's. */
const listeners = new Map<string, Set<() => void>>();

function notify(messageId: string) {
  for (const listener of listeners.get(messageId) ?? []) listener();
}

function storageKey(messageId: string) {
  return `${KEY_PREFIX}${messageId}`;
}

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const { selection, text } = value as Partial<Draft>;
  return (
    Array.isArray(selection) &&
    selection.every((id) => typeof id === "string") &&
    typeof text === "string"
  );
}

function parse(raw: string | null): { at: number; drafts: Drafts } | undefined {
  if (!raw) return undefined;
  try {
    const entry = JSON.parse(raw) as { at?: unknown; drafts?: unknown };
    if (typeof entry.at !== "number" || !entry.drafts || typeof entry.drafts !== "object")
      return undefined;
    const drafts = Object.entries(entry.drafts as Record<string, unknown>);
    if (!drafts.every(([, draft]) => isDraft(draft))) return undefined;
    return { at: entry.at, drafts: Object.fromEntries(drafts) as Drafts };
  } catch {
    return undefined;
  }
}

function load(messageId: string): Drafts {
  try {
    return parse(browserLocalStorage()?.getItem(storageKey(messageId)) ?? null)?.drafts ?? NONE;
  } catch {
    return NONE;
  }
}

/** The card's kept answers; the same object until they change. */
export function readQuestionDrafts(messageId: string): Drafts {
  let drafts = cache.get(messageId);
  if (!drafts) {
    drafts = load(messageId);
    cache.set(messageId, drafts);
  }
  return drafts;
}

/** What the server renders: nothing is kept there. */
export function serverQuestionDrafts(): Drafts {
  return NONE;
}

/** Keeps the card's answers; none left removes its entry. A full or blocked storage keeps them
 * for this page's life only. */
export function writeQuestionDrafts(messageId: string, drafts: Drafts) {
  const empty = Object.keys(drafts).length === 0;
  cache.set(messageId, empty ? NONE : drafts);
  try {
    const storage = browserLocalStorage();
    if (empty) storage?.removeItem(storageKey(messageId));
    else storage?.setItem(storageKey(messageId), JSON.stringify({ at: Date.now(), drafts }));
  } catch {
    // Kept in memory above; storage is a convenience.
  }
  notify(messageId);
}

/** The card is answered, declined or expired: nothing left to keep. Removes the entry without
 * reading it, as most cards a history shows never had one. */
export function dropQuestionDrafts(messageId: string) {
  if (cache.get(messageId) === NONE) return;
  cache.set(messageId, NONE);
  try {
    browserLocalStorage()?.removeItem(storageKey(messageId));
  } catch {
    // Nothing kept that storage could still hold.
  }
  notify(messageId);
}

/** Clears the entries no card can take any more. */
export function pruneQuestionDrafts(now = Date.now()) {
  try {
    const storage = browserLocalStorage();
    if (!storage) return;
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      const entry = parse(storage.getItem(key));
      if (!entry || now - entry.at > QUESTION_DRAFT_TTL_MS) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // Nothing to clear when storage cannot be read.
  }
}

let pruned = false;

function onStorage(event: { key: string | null }) {
  if (event.key === null) {
    cache.clear();
    for (const id of listeners.keys()) notify(id);
    return;
  }
  if (!event.key.startsWith(KEY_PREFIX)) return;
  const messageId = event.key.slice(KEY_PREFIX.length);
  cache.delete(messageId);
  notify(messageId);
}

/** Calls `listener` when the card's answers change, here or in another tab. Returns the way to
 * stop. */
export function subscribeQuestionDrafts(messageId: string, listener: () => void) {
  if (!pruned) {
    pruned = true;
    pruneQuestionDrafts();
  }
  if (!listeners.size) window.addEventListener("storage", onStorage);
  const own = listeners.get(messageId) ?? new Set();
  own.add(listener);
  listeners.set(messageId, own);
  return () => {
    own.delete(listener);
    if (!own.size) listeners.delete(messageId);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
