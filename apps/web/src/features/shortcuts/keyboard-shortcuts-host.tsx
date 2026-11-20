import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from "react";
import { useHotkeys, type HotkeyChord } from "@tanstack/react-hotkeys";

import { hasPrimaryModifier } from "#src/lib/hotkeys";
import { useIsRecordingShortcut, useShortcutBindings } from "./shortcut-bindings";

const KeyboardShortcutsDialog = lazy(() =>
  import("./keyboard-shortcuts-dialog").then((module) => ({
    default: module.KeyboardShortcutsDialog,
  })),
);

const OpenShortcutsContext = createContext<() => void>(() => undefined);

export function useOpenKeyboardShortcuts() {
  return useContext(OpenShortcutsContext);
}

export function KeyboardShortcutsHost({
  workspaceSlug,
  children,
}: {
  workspaceSlug?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bindings = useShortcutBindings("shortcuts");
  const recording = useIsRecordingShortcut();

  useHotkeys(
    bindings.map((hotkey) => ({
      hotkey: hotkey as HotkeyChord,
      callback: () => setOpen((current) => !current),
      options: {
        enabled: !recording,
        ignoreInputs: !hasPrimaryModifier(hotkey),
        requireReset: true,
      },
    })),
  );

  return (
    <OpenShortcutsContext value={() => setOpen(true)}>
      {children}
      {open && (
        <Suspense fallback={null}>
          <KeyboardShortcutsDialog
            open={open}
            onOpenChange={setOpen}
            workspaceSlug={workspaceSlug}
          />
        </Suspense>
      )}
    </OpenShortcutsContext>
  );
}
