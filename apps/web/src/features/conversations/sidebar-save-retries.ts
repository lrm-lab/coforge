import { isAppError, isAppErrorCode } from "#src/lib/app-error";

/** How long a section change waits before each retry of a save that failed on the way (the
 * network, or the server briefly unavailable). The change stays on screen meanwhile; only when the
 * last retry fails too does it go back. A few seconds in all: while a save is pending the lists
 * take channel events by re-reading (`applyChannelSignal`). */
export const SAVE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** A failure the same save may not meet again: the request did not get an answer, or the server
 * said it was briefly unavailable. A refusal (gone, not allowed, invalid) is final. */
function isTransient(error: unknown) {
  return !isAppError(error) || isAppErrorCode(error, "TEMPORARILY_UNAVAILABLE");
}

/** The sidebar's saves that are tried again after a failure on the way, and how many are waiting
 * to be (`savesRetrying`, for the header to say changes are still being saved). */
export function createSaveRetries({
  saveRetryDelaysMs = SAVE_RETRY_DELAYS_MS,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: { saveRetryDelaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {}) {
  let retryingCount = 0;
  const retryingListeners = new Set<() => void>();
  const setRetrying = (change: number) => {
    retryingCount += change;
    for (const listener of retryingListeners) listener();
  };
  const savesRetrying = {
    count: () => retryingCount,
    subscribe: (listener: () => void) => {
      retryingListeners.add(listener);
      return () => void retryingListeners.delete(listener);
    },
  };
  /** The newest save of each thing a save sets (a conversation's section, a section's field, the
   * order), so an older one waiting to be retried gives way to it. */
  const newest = new Map<string, symbol>();
  /**
   * Saves `save`, trying again after a failure on the way. Resolves `true` when saved, and `false`
   * when a newer save of `key` took over while this one waited: that one now decides what the
   * rows show, so this one changes nothing (it neither confirms its rows nor rolls them back,
   * which would roll the newer change back with it).
   */
  const withRetries = async (key: string, save: () => Promise<unknown>): Promise<boolean> => {
    const mine = Symbol(key);
    newest.set(key, mine);
    let retrying = false;
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await save();
          return true;
        } catch (error) {
          const delay = saveRetryDelaysMs[attempt];
          if (delay === undefined || !isTransient(error)) throw error;
          if (!retrying) setRetrying(+1);
          retrying = true;
          await sleep(delay);
          if (newest.get(key) !== mine) return false;
        }
      }
    } finally {
      if (newest.get(key) === mine) newest.delete(key);
      if (retrying) setRetrying(-1);
    }
  };
  return { withRetries, savesRetrying };
}
