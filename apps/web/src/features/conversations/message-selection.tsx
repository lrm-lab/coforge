import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { useAppToast } from "#src/components/ui/toast";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { m } from "#src/paraglide/messages";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { canForwardMessage, type ForwardSourceMessage } from "./message-forward-model";
import { messagePlainText } from "./selection-copy";
import {
  MESSAGE_SELECTION_MAX,
  MessageSelectionStore,
  type MessageSelectionState,
} from "./message-selection-model";
import type { MessageView } from "./message-view";

export type MessageSelectionActions = {
  toggle: (conversationId: string, entry: ForwardSourceMessage) => void;
  exit: () => void;
};

type MessageSelectionContextValue = MessageSelectionActions & {
  store: MessageSelectionStore;
};

const MessageSelectionContext = createContext<MessageSelectionContextValue | null>(null);

function noop() {}

export function MessageSelectionHost({ children }: { children: ReactNode }) {
  const toast = useAppToast();
  const [store] = useState(() => new MessageSelectionStore());
  const toggle = useLatestCallback((conversationId: string, entry: ForwardSourceMessage) => {
    const result = store.toggle(conversationId, entry);
    if (result.full) toast.notice(m.message_select_limit({ max: MESSAGE_SELECTION_MAX }));
  });
  const exit = useLatestCallback(() => store.exit());
  const active = useSyncExternalStore(
    store.subscribeAnyActive,
    () => store.anyActive,
    () => false,
  );
  useHotkey(
    "Escape",
    () => {
      if (!document.querySelector(OPEN_OVERLAY_SELECTOR)) exit();
    },
    { enabled: active, preventDefault: true },
  );
  const value = useMemo(() => ({ store, toggle, exit }), [store, toggle, exit]);
  return <MessageSelectionContext value={value}>{children}</MessageSelectionContext>;
}

export function useMessageSelection(): MessageSelectionActions | null {
  return useContext(MessageSelectionContext);
}

export function useIsSelectingIn(conversationId: string | undefined): boolean {
  const selection = useContext(MessageSelectionContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      selection && conversationId
        ? selection.store.subscribeConversationActive(conversationId, listener)
        : noop,
    [selection, conversationId],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      Boolean(selection && conversationId && selection.store.isConversationActive(conversationId)),
    () => false,
  );
}

export function useSelectionIn(conversationId: string | undefined): {
  state: MessageSelectionState;
  toggle: MessageSelectionActions["toggle"];
  exit: MessageSelectionActions["exit"];
} | null {
  const selection = useContext(MessageSelectionContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      selection && conversationId
        ? selection.store.subscribeConversationState(conversationId, listener)
        : noop,
    [selection, conversationId],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => (selection && conversationId ? selection.store.stateFor(conversationId) : null),
    () => null,
  );
  if (!selection || !state) return null;
  return { state, toggle: selection.toggle, exit: selection.exit };
}

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
  const selection = useContext(MessageSelectionContext);
  const subscribeActive = useCallback(
    (listener: () => void) =>
      selection && inStream && conversationId
        ? selection.store.subscribeConversationActive(conversationId, listener)
        : noop,
    [selection, inStream, conversationId],
  );
  const active = useSyncExternalStore(
    subscribeActive,
    () =>
      Boolean(
        selection &&
        inStream &&
        conversationId &&
        selection.store.isConversationActive(conversationId),
      ),
    () => false,
  );
  const subscribeSelected = useCallback(
    (listener: () => void) =>
      selection && active && conversationId
        ? selection.store.subscribeMessageSelected(conversationId, message.id, listener)
        : noop,
    [selection, active, conversationId, message.id],
  );
  const selected = useSyncExternalStore(
    subscribeSelected,
    () =>
      Boolean(
        selection &&
        active &&
        conversationId &&
        selection.store.isMessageSelected(conversationId, message.id),
      ),
    () => false,
  );
  if (!selection || !active || !inStream || !conversationId) return null;
  const selectable = canForwardMessage(message);
  const toggle = () =>
    selection.toggle(conversationId, {
      message,
      plainBody: messagePlainText(message, channelNames),
    });
  return {
    selected,
    onClick: (event: React.MouseEvent) => {
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
