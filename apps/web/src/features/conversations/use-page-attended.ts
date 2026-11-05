import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

/**
 * Whether someone is looking at the page: it is on screen (`document.visibilityState`) and its
 * window has focus (`document.hasFocus()`), re-rendering when either changes. A read is reported
 * only then (task #549), as Raft's page does: a background tab, or a window left behind another
 * one, that loads a message has not shown it to anyone, and the effect that reports reads runs
 * again when the window is in front with focus.
 */
export function usePageAttended(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState === "visible" && document.hasFocus(),
    // Server render: nothing is reported from there anyway.
    () => true,
  );
}
