/**
 * The unsent messages on this device, across every conversation: what the Drafts page lists. They
 * are the composer drafts (`composer-draft.ts`) read back out of `localStorage` by key, so nothing
 * is stored twice. A file's comment draft, a draft's pins and edit time, and a blank text are not
 * listed. Hear of a change through `subscribeComposerDrafts`; this file keeps the read, and keeps it
 * current from the changes `composer-draft.ts` reports: one draft's key re-reads that draft alone.
 */

import { browserLocalStorage } from "#src/features/browser-local-storage";
import {
  observeComposerDrafts,
  placeOfDraftKey,
  stampKey,
  type DraftPlace,
} from "./composer-draft";

export type DeviceDraft = {
  key: string;
  place: DraftPlace;
  body: string;
  /** When the text was last changed (epoch ms); `null` for a draft saved before that was kept. */
  updatedAt: number | null;
};

/** The more recently edited first; a draft with no edit time after those that have one; then by key. */
function compareDrafts(left: DeviceDraft, right: DeviceDraft): number {
  return (
    (right.updatedAt ?? -1) - (left.updatedAt ?? -1) ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  );
}

/** One draft read from storage, or nothing when it has no text. */
function readDraft(storage: Storage, key: string, place: DraftPlace): DeviceDraft | undefined {
  const body = storage.getItem(key);
  if (!body?.trim()) return undefined;
  const stamp = Number(storage.getItem(stampKey(key)));
  return { key, place, body, updatedAt: stamp > 0 && Number.isFinite(stamp) ? stamp : null };
}

/** Every non-blank draft on this device, in the order of `compareDrafts`. */
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
  } catch {
    // Storage went away mid-read: list what was read.
  }
  return drafts.sort(compareDrafts);
}

/** `drafts` with the draft stored under `key` as it is now: added, replaced or removed, in order.
 * Reads that draft alone. */
function withDraft(drafts: readonly DeviceDraft[], key: string): DeviceDraft[] {
  const place = placeOfDraftKey(key);
  const storage = browserLocalStorage();
  let current: DeviceDraft | undefined;
  try {
    current = place && storage ? readDraft(storage, key, place) : undefined;
  } catch {
    // Storage went away: the draft is gone as far as this device can tell.
  }
  const others = drafts.filter((draft) => draft.key !== key);
  if (!current) return others;
  const at = others.findIndex((draft) => compareDrafts(current, draft) < 0);
  return at < 0 ? [...others, current] : [...others.slice(0, at), current, ...others.slice(at)];
}

/** The list the page last read, or nothing before the first read and after a change of unknown
 * extent. */
let cached: DeviceDraft[] | undefined;

observeComposerDrafts((change) => {
  if (!cached) return;
  cached = change === null ? undefined : withDraft(cached, change);
});

/** The drafts on this device for `useSyncExternalStore`: the same list until a change was heard of
 * (`subscribeComposerDrafts`), so rendering never reads storage again. A change to one draft
 * gives a new list that re-reads that draft alone; only a change of unknown extent reads every
 * key again. */
export function deviceDrafts(): DeviceDraft[] {
  return (cached ??= listComposerDrafts());
}
