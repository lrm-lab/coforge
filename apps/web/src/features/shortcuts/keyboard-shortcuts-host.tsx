import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

import { HOTKEYS } from "#src/lib/hotkeys";

const KeyboardShortcutsDialog = lazy(() =>
  import("./keyboard-shortcuts-dialog").then((module) => ({
    default: module.KeyboardShortcutsDialog,
  })),
);

const OpenShortcutsContext = createContext<() => void>(() => undefined);

export function useOpenKeyboardShortcuts() {
  return useContext(OpenShortcutsContext);
}

export function KeyboardShortcutsHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useHotkey(HOTKEYS.shortcuts, () => setOpen((current) => !current), {
    ignoreInputs: false,
    requireReset: true,
  });
  return (
    <OpenShortcutsContext value={() => setOpen(true)}>
      {children}
      {open && (
        <Suspense fallback={null}>
          <KeyboardShortcutsDialog open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </OpenShortcutsContext>
  );
}
