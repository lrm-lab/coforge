import { createContext, type RefObject, useContext, useEffect, useState } from "react";

import { SEARCH_KEY } from "#src/features/search/search-key-hints";
import { m } from "#src/paraglide/messages";

export const ActivityFlowHintContext = createContext<{
  done: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
} | null>(null);

export function ActivityFlowHint() {
  const flow = useContext(ActivityFlowHintContext);
  const composerRef = flow?.composerRef;
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
  return (
    <div
      aria-hidden
      data-activity-flow-hint
      className="flex h-8 shrink-0 items-center gap-3 rounded-full bg-primary px-2.5 text-xs text-tertiary shadow-xs ring-1 ring-secondary ring-inset"
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
