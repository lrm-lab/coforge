import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { useAppToast } from "#src/components/ui/toast";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { m } from "#src/paraglide/messages";
import { canForwardMessage, type ForwardSourceMessage } from "./message-forward-model";
import { messagePlainText } from "./selection-copy";
import {
  MESSAGE_SELECTION_MAX,
  toggleSelected,
  type MessageSelectionState,
} from "./message-selection-model";
import type { MessageView } from "./message-view";

type MessageSelection = {
  state: MessageSelectionState | null;
  /** Picks or unpicks a message; the first pick starts select mode in its conversation. */
  toggle: (conversationId: string, entry: ForwardSourceMessage) => void;
  exit: () => void;
};

const MessageSelectionContext = createContext<MessageSelection | null>(null);

/**
 * Select mode ("Select messages"): a conversation's stream with a checkbox on each
 * message that can be forwarded and a bar in place of the composer, acting on the picked ones
 * together (`MessageSelectionBar`). One conversation at a time; Escape or the bar's close leaves.
 * It lives with the conversation host, and only the conversation's own stream offers it, not a
 * thread pane.
 */
export function MessageSelectionHost({ children }: { children: ReactNode }) {
  const toast = useAppToast();
  const [state, setState] = useState<MessageSelectionState | null>(null);
  const toggle = useLatestCallback((conversationId: string, entry: ForwardSourceMessage) => {
    const next = toggleSelected(state, conversationId, entry);
    if (next.full) toast.error(m.message_select_limit({ max: MESSAGE_SELECTION_MAX }));
    else setState(next.state);
  });
  const exit = useLatestCallback(() => setState(null));
  const active = state !== null;
  useEffect(() => {
    if (!active) return;
    const leave = (event: KeyboardEvent) => {
      // A dialog or menu open over the stream takes its own Escape first.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      setState(null);
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [active]);
  const value = useMemo(() => ({ state, toggle, exit }), [state, toggle, exit]);
  return <MessageSelectionContext value={value}>{children}</MessageSelectionContext>;
}

/** Select mode's state and controls; null outside a conversation host. */
export function useMessageSelection(): MessageSelection | null {
  return useContext(MessageSelectionContext);
}

/** Select mode as one conversation's stream sees it: its state while it is the one selecting. */
export function useSelectionIn(conversationId: string | undefined) {
  const selection = useMessageSelection();
  return selection?.state && selection.state.conversationId === conversationId
    ? { ...selection, state: selection.state }
    : null;
}

/**
 * A row in select mode: its checkbox (a blank of the same width on a message that cannot be
 * picked, so the stream stays on one column), the click that picks it anywhere on the row, and
 * the tint of a picked one. Nothing outside select mode, or in a thread pane (`inStream` false).
 */
export function useRowSelection({
  message,
  conversationId,
  channelNames,
  inStream,
}: {
  message: MessageView;
  conversationId?: string;
  channelNames?: ReadonlyMap<string, string>;
  inStream: boolean;
}) {
  const selection = useSelectionIn(conversationId);
  if (!selection || !inStream || !conversationId) return null;
  const selectable = canForwardMessage(message);
  const selected = selection.state.picked.has(message.id);
  const toggle = () =>
    selection.toggle(conversationId, {
      message,
      plainBody: messagePlainText(message, channelNames),
    });
  return {
    selected,
    onClick: (event: React.MouseEvent) => {
      // A link or a control in the message keeps its own click; the checkbox picks by itself.
      if (
        !selectable ||
        (event.target instanceof Element &&
          event.target.closest("a, button, input, label, [role=button], [data-no-row-tap]"))
      )
        return;
      toggle();
    },
    checkbox: (
      <span className="flex w-5 shrink-0 pt-2.5" data-select-checkbox>
        {selectable && (
          <Checkbox
            size="md"
            aria-label={m.message_select_pick()}
            isSelected={selected}
            onChange={toggle}
          />
        )}
      </span>
    ),
  };
}
