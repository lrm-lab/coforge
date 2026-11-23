import { createContext, type RefObject, useContext, useEffect, useState } from "react";

import { HotkeyKeycaps, Keycap } from "#src/components/ui/kbd";
import { COMPOSER_EDGE_PILL_CLASS } from "#src/features/conversations/composer-edge-pill";
import { useShortcutBindings } from "#src/features/shortcuts/shortcut-bindings";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export const ActivityFlowHintContext = createContext<{
  done: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
} | null>(null);

export function ActivityFlowHint() {
  const flow = useContext(ActivityFlowHintContext);
  const composerRef = flow?.composerRef;
  const nextKeys = useShortcutBindings("activityNext");
  const prevKeys = useShortcutBindings("activityPrev");
  const doneKeys = useShortcutBindings("activityDone");
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!composerRef) return;
    const onFocusIn = (event: FocusEvent) => setTyping(event.target === composerRef.current);
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget === null) setTyping(false);
    };
    setTyping(document.activeElement === composerRef.current);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [composerRef]);
  const switchHotkeys = [nextKeys[0], prevKeys[0]].filter((key): key is string => Boolean(key));
  const doneHotkey = doneKeys[0];
  return (
    <div
      aria-hidden
      data-activity-flow-hint
      className={cx(
        COMPOSER_EDGE_PILL_CLASS,
        "flex shrink-0 items-center gap-3 px-2.5 text-tertiary",
      )}
    >
      {typing ? (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <Keycap>Esc</Keycap>
          {m.activity_flow_back()}
        </span>
      ) : (
        <>
          {switchHotkeys.length > 0 && (
            <HotkeyHint hotkeys={switchHotkeys} label={m.activity_flow_switch()} />
          )}
          {flow?.done && doneHotkey && (
            <HotkeyHint hotkeys={[doneHotkey]} label={m.activity_inbox_menu_done()} />
          )}
        </>
      )}
    </div>
  );
}

function HotkeyHint({ hotkeys, label }: { hotkeys: readonly string[]; label: string }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {hotkeys.map((hotkey) => (
        <HotkeyKeycaps key={hotkey} hotkey={hotkey} ariaHidden />
      ))}
      {label}
    </span>
  );
}
