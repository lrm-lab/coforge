import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { useLatestCallback } from "#src/hooks/use-latest-callback";

/**
 * Lets a phone's back gesture close an open overlay instead of leaving the page under it. While
 * `active`, one history entry is pushed (at the same address, so the router has nothing to load);
 * a Back that pops it calls `close`. When the overlay closes any other way, the entry is popped
 * here, unless the page has already moved on, so a navigation that closed the overlay is not undone.
 */
export function useCloseOnBack(active: boolean, close: () => void) {
  const router = useRouter();
  const onBack = useLatestCallback(close);
  useEffect(() => {
    if (!active) return;
    const { history } = router;
    history.push(history.location.href);
    const pushed = history.location.state.__TSR_key;
    let popped = false;
    const unsubscribe = history.subscribe(({ action }) => {
      if (action.type !== "BACK" || popped) return;
      popped = true;
      onBack();
    });
    return () => {
      unsubscribe();
      if (!popped && history.location.state.__TSR_key === pushed) history.back();
    };
  }, [active, router, onBack]);
}
