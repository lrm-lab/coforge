import { createContext, useContext, useEffect, useEffectEvent, useMemo, useState } from "react";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { shouldExitOnEscape, type FocusedPanel } from "./conversation-focus-model";

export type ConversationFocus = {
  focused: FocusedPanel | undefined;
  toggle: (panel: FocusedPanel) => void;
};

export const ConversationFocusContext = createContext<ConversationFocus | null>(null);

export function useConversationFocus(): ConversationFocus | null {
  return useContext(ConversationFocusContext);
}

export function useConversationFocusState(layoutKey: string, desktop: boolean): ConversationFocus {
  const [state, setState] = useState<{ panel: FocusedPanel; key: string }>();
  if (state && (state.key !== layoutKey || !desktop)) setState(undefined);
  const focused = state?.key === layoutKey && desktop ? state.panel : undefined;

  // Esc leaves focus last: anything else on the page that takes it (select mode, a completion, the
  // profile panel) marks it taken during the dispatch, so the decision waits until that is over.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!focused) return;
    if (!shouldExitOnEscape(event, () => document.querySelector(OPEN_OVERLAY_SELECTOR) !== null))
      return;
    setTimeout(() => {
      if (!event.defaultPrevented) setState(undefined);
    });
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return useMemo(
    () => ({
      focused,
      toggle: (panel) => setState(focused === panel ? undefined : { panel, key: layoutKey }),
    }),
    [focused, layoutKey],
  );
}
