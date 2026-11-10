import { createContext, useContext, useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  OPEN_OVERLAY_SELECTOR,
  shouldExitOnEscape,
  type FocusedPanel,
} from "./conversation-focus-model";

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
 * The focus state, held over the conversation list and the chat. Focus belongs to what was in view
 * when it was set (`layoutKey`: the conversation and its side slot), so opening or closing a thread
 * or a profile, or moving to another conversation, leaves it; so does a window narrower than `lg`.
 */
export function useConversationFocusState(layoutKey: string, desktop: boolean): ConversationFocus {
  const [state, setState] = useState<{ panel: FocusedPanel; key: string }>();
  const focused = desktop && state?.key === layoutKey ? state.panel : undefined;

  // Attached for the page's life, so the open Agent profile's own Esc listener, added later, sees
  // the key already taken.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!focused) return;
    if (!shouldExitOnEscape(event, () => document.querySelector(OPEN_OVERLAY_SELECTOR) !== null))
      return;
    event.preventDefault();
    setState(undefined);
  });
  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return useMemo(
    () => ({
      focused,
      toggle: (panel) => setState(focused === panel ? undefined : { panel, key: layoutKey }),
    }),
    [focused, layoutKey],
  );
}
