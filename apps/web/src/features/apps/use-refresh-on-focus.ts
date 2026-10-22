import { useEffect, useRef } from "react";

/** The least time between two refreshes on focus. */
const MIN_REFRESH_INTERVAL_MS = 5000;

/** Runs `refresh` whenever the window gains focus while `enabled`, at most once per
 * `MIN_REFRESH_INTERVAL_MS`, and ignores its failure: the page keeps what it shows, and a refresh
 * the person asks for reports its own. */
export function useRefreshOnFocus(refresh: () => Promise<void>, enabled: boolean) {
  const lastRefreshAt = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < MIN_REFRESH_INTERVAL_MS) return;
      lastRefreshAt.current = now;
      void refresh().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, enabled]);
}
