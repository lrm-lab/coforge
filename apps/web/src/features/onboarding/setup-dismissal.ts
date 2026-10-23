import { useSyncExternalStore } from "react";
import { readDeviceFlag, writeDeviceFlag } from "#src/features/settings/device-flag";

const listeners = new Set<() => void>();
/** What this page view hid, kept for storage that is blocked: the close button must still work. */
const hiddenThisView = new Set<string>();

/** One key per person and Workspace, so a shared browser keeps each person's choice apart. */
function flagKey(workspaceId: string, userId: string) {
  return `coforge-setup-checklist:${userId}:${workspaceId}`;
}

/** Hides the checklist for this person and Workspace in this browser, and on the cards showing it. */
export function dismissSetupChecklist(workspaceId: string, userId: string) {
  const key = flagKey(workspaceId, userId);
  hiddenThisView.add(key);
  writeDeviceFlag(key, false);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Whether the person hid the checklist here. Hidden on the server, so the first render matches
 * the card that stays out of the page until its steps have loaded. */
export function useSetupChecklistDismissed(workspaceId: string, userId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      const key = flagKey(workspaceId, userId);
      return hiddenThisView.has(key) || !readDeviceFlag(key);
    },
    () => true,
  );
}
