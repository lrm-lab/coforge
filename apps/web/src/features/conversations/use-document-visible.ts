import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Whether the page is on screen (`document.visibilityState`), re-rendering when it changes. A read
 * is reported only while it is (task #549): a background tab that receives a message has not shown
 * it to anyone, and the effect that reports reads runs again when the page comes back. A window
 * that is visible but not focused still counts, as a person can be reading it beside another one.
 */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState !== "hidden",
    // Server render: nothing is reported from there anyway.
    () => true,
  );
}
