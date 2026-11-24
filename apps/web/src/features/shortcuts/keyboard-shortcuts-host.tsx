import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
  const openDialog = useCallback(() => setOpen(true), []);
  const bindings = useShortcutBindings("shortcuts");
  const recording = useIsRecordingShortcut();

  const hotkeys = useMemo(
    () =>
      bindings.map((hotkey) => ({
        hotkey: hotkey as HotkeyChord,
        callback: () => setOpen((current) => !current),
        options: {
          enabled: !recording,
          ignoreInputs: !hasPrimaryModifier(hotkey),
          requireReset: true,
        },
      })),
    [bindings, recording],
  );
  useHotkeys(hotkeys);

  return (
    <OpenShortcutsContext value={openDialog}>
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
