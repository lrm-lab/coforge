export type ConversationMessage = { id: string; sequence: number };

/**
 * Where a read of what arrived starts: after `afterSequence`, every message; and, when the window
 * already reflects replies past it (its thread summaries do), only the replies after
 * `afterReplySequence`. A window reads top-level messages and holds each thread as a summary, so
 * the newest root can be far behind the newest reply, and the replies in between must not be read
 * again (a busy channel's newest threads hold hundreds). Roots keep their own cursor because the
 * summaries and the roots are read apart, and only a root's own sequence proves it was read.
 */
export type ConversationUpdatesCursor = { afterSequence: number; afterReplySequence?: number };

/** How long a failed catch-up waits before it tries again: doubling from `firstMs` up to `maxMs`,
 * with jitter so the pages that lost the server together do not come back together. */
export const RECONCILE_RETRY = { firstMs: 1_000, maxMs: 30_000 };

/**
 * Keeps a conversation caught up with what arrived past its cursor. One read runs at a time; a
 * read has the deadline every read from the browser has (`lib/read-deadline.ts`), so one stuck on
 * a dead connection fails instead of holding every later catch-up (task #253). A failure is
 * retried after `RECONCILE_RETRY`, and only while the page is visible: coming back restarts it.
 */
export function createConversationReconciler<T extends ConversationMessage>(
  start: ConversationUpdatesCursor,
  loadPage: (cursor: ConversationUpdatesCursor, signal: AbortSignal) => Promise<T[]>,
  mergePage: (messages: T[]) => void,
  {
    retry = RECONCILE_RETRY,
    canRetry = () => typeof document === "undefined" || document.visibilityState === "visible",
    random = Math.random,
  } = {},
) {
  let cursor = start;
  let requested = false;
  let active: Promise<void> | undefined;
  let reading: AbortController | undefined;
  let failures = 0;
  /** The newest message the first catch-up of this open found; unset until one has landed. */
  let caughtUpThrough: number | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const readToTheEnd = async (signal: AbortSignal) => {
    let page: T[];
    do {
      page = await loadPage(cursor, signal);
      if (page.length) {
        // A page holds everything past the cursor up to its newest message, so one cursor
        // stands for both from here on.
        cursor = {
          afterSequence: Math.max(cursor.afterSequence, ...page.map((m) => m.sequence)),
        };
        mergePage(page);
      }
    } while (page.length === 100);
  };

  const drain = async () => {
    while (requested) {
      requested = false;
      const controller = new AbortController();
      reading = controller;
      try {
        await readToTheEnd(controller.signal);
        const changed = failures > 0 || caughtUpThrough === undefined;
        failures = 0;
        caughtUpThrough ??= cursor.afterSequence;
        if (changed) notify();
      } catch (error) {
        // Abandoned by a restart, which asked for the read that follows, or by `stop`.
        if (controller.signal.aborted) continue;
        failures += 1;
        notify();
        console.warn("conversation catch-up failed", failures, error);
        const delay = Math.min(retry.maxMs, retry.firstMs * 2 ** (failures - 1));
        retryTimer = setTimeout(
          () => {
            retryTimer = undefined;
            requested = true;
            if (canRetry()) run();
          },
          delay * (0.5 + random() / 2),
        );
        return;
      } finally {
        reading = undefined;
      }
    }
  };

  const run = (): Promise<void> =>
    (active ??= drain().finally(() => {
      active = undefined;
      // Asked for between the last read and here, after `drain` stopped looking.
      if (requested && retryTimer === undefined) void run();
    }));

  return {
    /** Whether a read has caught the conversation up since this reconciler started (its open). */
    caughtUp: () => caughtUpThrough !== undefined,
    /**
     * The newest message there was when the open was caught up: what arrives past it came while
     * the conversation was open. A sequence, not the moment `caughtUp` turns: the merge that
     * brought the messages up to it reaches the window's observers on Query's schedule, which may
     * be after this is heard.
     */
    caughtUpThrough: () => caughtUpThrough,
    /** How many catch-ups failed in a row; 0 once one landed. */
    failures: () => failures,
    /** Called when `caughtUp` or `failures` changes. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * The window read past the cursor by itself (its own refetch), so what it holds is not read
     * again. It only moves forward: a window that slid back into history does not move it back.
     * A conversation opened from the browser's stored copy starts the cursor there, and the read
     * that follows brings the window to the present. The whole cursor is replaced: a newer window
     * reflects replies at least as far as an older one, so its reply cursor is never behind. Until
     * that read lands, a realtime signal still reads from the stored copy's cursor.
     */
    advance(to: ConversationUpdatesCursor) {
      if (to.afterSequence > cursor.afterSequence) cursor = to;
    },
    /** Nothing was published since the window was read (the page's first subscribe compared
     * their stream positions): the page is caught up without a read, through the newest message
     * the window holds (`windowThrough`), which a window replaced since the open may have past the
     * cursor. One under way still decides. */
    caughtUpWithoutRead(windowThrough = 0) {
      if (caughtUpThrough !== undefined || active) return;
      caughtUpThrough = Math.max(cursor.afterSequence, windowThrough);
      notify();
    },
    /**
     * Reads what arrived past the cursor; the promise settles when the page is caught up or the
     * read failed (and its retry is scheduled). A call made while a read runs asks for one more
     * after it, and one made while a failure waits out its retry waits with it. `restart` (the
     * page came back: visible, online, or a resubscribe that could not replay what it missed)
     * abandons the read in flight, which may be stuck on a connection that died meanwhile, and the
     * retry's wait, and reads again at once.
     */
    reconcile({ restart = false }: { restart?: boolean } = {}): Promise<void> {
      requested = true;
      if (retryTimer !== undefined) {
        if (!restart) return Promise.resolve();
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (restart) reading?.abort();
      return run();
    },
    /** The conversation was left: the read in flight and a pending retry are dropped. A later
     * call reads again (React runs an effect's cleanup and the effect again on a remount). */
    stop() {
      requested = false;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      reading?.abort();
    },
  };
}
