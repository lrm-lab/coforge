/** How long typing rests before what was typed saves by itself (Frank, 11-05: no Save button). */
export const AUTOSAVE_MS = 1000;

/**
 * Whether a document's edits may save by themselves now: something is unsaved, it is read and
 * writable, no save is in flight, and nothing stopped the last one. A failed save, a base that
 * moved past merging, or a save that gave up on conflicts it kept meeting (`stalled`) each wait
 * for the person: the next edit, Try Again, or a refresh. Without that wait, each settled save
 * would arm the next at once, sending saves every second for as long as the page is open.
 */
export function canAutosave(state: {
  dirty: boolean;
  loaded: boolean;
  readOnly: boolean;
  saving: boolean;
  failed: boolean;
  baseMoved: boolean;
  stalled: boolean;
}): boolean {
  return (
    state.dirty &&
    state.loaded &&
    !state.readOnly &&
    !state.saving &&
    !state.failed &&
    !state.baseMoved &&
    !state.stalled
  );
}
