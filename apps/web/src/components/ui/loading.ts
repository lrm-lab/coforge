import { useEffect, useRef, useState } from "react";

/**
 * How long a control stays busy before its loading indicator appears, and how long the indicator
 * stays once it has appeared.
 *
 * Below `SHOW_DELAY_MS` nothing renders, so an action that finishes quickly never flashes an
 * indicator (NN/g: a looped animation shown for under a second is "display inertia" — users
 * cannot follow it and a fast interface starts to look unreliable). At or above it the indicator
 * stays for `MIN_VISIBLE_MS`, so it can never appear and vanish a frame later, which reads as a
 * glitch rather than as loading.
 *
 * These are the control-level siblings of the router's `PENDING_DELAY_MS`/`PENDING_MIN_MS`
 * (`lib/pending-policy.ts`). The router holds its fallback for 300ms because an entire view is
 * changing underneath it; a control that has already changed its own look reads as laggy if its
 * indicator waits that long, which is why the delay here is shorter than the router's.
 */
const SHOW_DELAY_MS = 150;
const MIN_VISIBLE_MS = 400;

/**
 * Whether the loading indicator for `active` should be on screen right now.
 *
 * The caller stays responsible for the immediate feedback — disabling the control, changing its
 * look at once — so that the wait before the indicator appears is never a dead one. Keeping the
 * two separate is the point: the indicator is delayed, the feedback is not.
 */
export function useLoadingVisible(active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);

    if (active) {
      showTimer.current = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, SHOW_DELAY_MS);

      return () => clearTimeout(showTimer.current);
    }

    // Never appeared: there is nothing to keep on screen, so nothing flashes.
    if (shownAt.current === 0) {
      setVisible(false);
      return;
    }

    const remaining = MIN_VISIBLE_MS - (Date.now() - shownAt.current);
    shownAt.current = 0;

    if (remaining <= 0) {
      setVisible(false);
      return;
    }

    hideTimer.current = setTimeout(() => setVisible(false), remaining);

    return () => clearTimeout(hideTimer.current);
  }, [active]);

  return visible;
}
