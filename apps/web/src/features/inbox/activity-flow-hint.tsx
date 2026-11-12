import { createContext, type RefObject, useContext, useEffect, useState } from "react";

import { SEARCH_KEY } from "#src/features/search/search-key-hints";
import { m } from "#src/paraglide/messages";

/** Whether the list's selected row can be Done, which the hint offers E for, and the composer
 * whose caret turns it to the way back. */
export const ActivityFlowHintContext = createContext<{
  done: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
} | null>(null);

/**
 * The keys that run Activity from the keyboard, floating over the open conversation's composer
 * (Frank, 11-12): J K and E while the caret is in the list (E only for a row that can be Done),
 * Esc while it is in the composer the pane hosts. Only the ones used on every row; the rest are
 * in the rows' tooltips. It follows the caret itself, so a focus change renders only the hint.
 */
export function ActivityFlowHint() {
  const flow = useContext(ActivityFlowHintContext);
  const composerRef = flow?.composerRef;
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!composerRef) return;
    const onFocusIn = (event: FocusEvent) => setTyping(event.target === composerRef.current);
    // Leaving for nothing (the window, the page itself) sends no focusin after it.
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
  return (
    <div
      aria-hidden
      data-activity-flow-hint
      className="mb-1.5 flex shrink-0 items-center gap-3 rounded-full bg-primary px-2.5 py-1 text-xs text-tertiary shadow-xs ring-1 ring-secondary ring-inset"
    >
      {typing ? (
        <Keys keys={["Esc"]} label={m.activity_flow_back()} />
      ) : (
        <>
          <Keys keys={["J", "K"]} label={m.activity_flow_switch()} />
          {flow?.done && <Keys keys={["E"]} label={m.activity_inbox_menu_done()} />}
        </>
      )}
    </div>
  );
}

function Keys({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {keys.map((key) => (
        <kbd key={key} className={SEARCH_KEY}>
          {key}
        </kbd>
      ))}
      {label}
    </span>
  );
}
