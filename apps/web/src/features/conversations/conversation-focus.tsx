import { createContext, useContext, useEffect, useEffectEvent, useMemo, useState } from "react";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { shouldExitOnEscape, type FocusedPanel } from "./conversation-focus-model";

/** The chat page's focus mode: one panel fills the content card, the others hide. Page-local, so
 * a reload starts without it. */
export type ConversationFocus = {
  focused: FocusedPanel | undefined;
  toggle: (panel: FocusedPanel) => void;
};

/** Null outside the chat page (Activity, the Task popup): there is no focus to offer. */
export const ConversationFocusContext = createContext<ConversationFocus | null>(null);

export function useConversationFocus(): ConversationFocus | null {
  return useContext(ConversationFocusContext);
}

/**
 * The focus state, held over the conversation list and the chat. Focus belongs to the layout it
 * was set in (`layoutKey`: the conversation and its side slot), so opening or closing a thread or a
 * profile, or moving to another conversation, ends it; so does a window narrower than `lg`.
 */
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
