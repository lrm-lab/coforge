import type { RouterHistory } from "@tanstack/react-router";

/**
 * The history entries of Task popups opened from another Task's popup — a sub-task, a parent, a
 * Task waited on. Each is one step down from the popup it was opened from, so Esc and the popup's
 * back arrow step back up to it, and only the first popup closes. Browser Back steps the same way
 * on its own, since every opening pushes an entry.
 *
 * The mark lives here, by the entry's key, rather than in the entry's state: the hosts open a Task
 * each their own way (a conversation's `task` param, the Tasks page's, another channel's page).
 * An entry the router then replaces in place (a page filling in its default search) keeps the mark.
 * A reload forgets the marks, and Esc then closes, as it would on a link opened afresh.
 */
const steps = new Set<string>();

/** How long an opening may take to push its entry before it is no longer taken as a step. */
const OPEN_WINDOW_MS = 2_000;

/** A history location as the router or its history reports it: only the entry's key is read. */
type Entry = { state: { __TSR_key?: string; key?: string } };

const entryKey = (location: Entry) => location.state.__TSR_key ?? location.state.key;

let watched: RouterHistory | undefined;
let shown: string | undefined;
let pendingUntil = 0;

/** Follows the history from the first opening on: marks the pushed entry, keeps marks on replace. */
function watch(history: RouterHistory) {
  if (watched === history) return;
  watched = history;
  shown = entryKey(history.location);
  history.subscribe(({ location, action }) => {
    const key = entryKey(location);
    if (key && action.type === "PUSH" && Date.now() < pendingUntil) {
      pendingUntil = 0;
      steps.add(key);
    } else if (key && action.type === "REPLACE" && shown && steps.has(shown)) {
      steps.add(key);
    }
    shown = key;
  });
}

/** Runs `open`, which navigates to another Task's popup, and marks the entry it pushes as a step. */
export function openTaskAsStep(history: RouterHistory, open: () => void) {
  watch(history);
  // An opening that navigates nowhere (a channel no longer listed) must not mark a later entry.
  pendingUntil = Date.now() + OPEN_WINDOW_MS;
  open();
}

/** Whether the entry shown is a popup opened from another Task's popup. */
export function isTaskStep(location: Entry) {
  const key = entryKey(location);
  return key !== undefined && steps.has(key);
}
