import { Fragment } from "react";

import { HotkeyKeycaps } from "#src/components/ui/kbd";
import { m } from "#src/paraglide/messages";

export function ShortcutKeycapGroup({ hotkey, apple }: { hotkey: string; apple: boolean }) {
  return <HotkeyKeycaps hotkey={hotkey} apple={apple} />;
}

export function ShortcutKeycaps({
  hotkeys,
  apple,
}: {
  hotkeys: readonly string[];
  apple: boolean;
}) {
  if (hotkeys.length === 0) {
    return <span className="shrink-0 text-xs text-quaternary">{m.shortcuts_unassigned()}</span>;
  }
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {hotkeys.map((hotkey, index) => (
        <Fragment key={hotkey}>
          {index > 0 && <span className="px-0.5 text-xs text-quaternary">{m.shortcuts_or()}</span>}
          <ShortcutKeycapGroup hotkey={hotkey} apple={apple} />
        </Fragment>
      ))}
    </span>
  );
}
