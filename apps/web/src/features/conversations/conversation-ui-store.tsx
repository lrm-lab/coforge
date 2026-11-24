import { createContext, useContext, type ReactNode } from "react";
import { createStore, useSelector, type Store } from "@tanstack/react-store";

export type QuotedDraft = { id: number; text: string };

export type ConversationUiState = {
  quotedDraft: QuotedDraft | undefined;
  jumpHighlightId: string | undefined;
};

const EMPTY_CONVERSATION_UI_STATE: ConversationUiState = {
  quotedDraft: undefined,
  jumpHighlightId: undefined,
};

export function createConversationUiStore(): Store<ConversationUiState> {
  return createStore<ConversationUiState>(EMPTY_CONVERSATION_UI_STATE);
}

const defaultStore = createConversationUiStore();
const ConversationUiStoreContext = createContext<Store<ConversationUiState>>(defaultStore);

export function ConversationUiStoreProvider({
  store,
  children,
}: {
  store: Store<ConversationUiState>;
  children: ReactNode;
}) {
  return <ConversationUiStoreContext value={store}>{children}</ConversationUiStoreContext>;
}

export function useQuotedDraft(): QuotedDraft | undefined {
  return useSelector(useContext(ConversationUiStoreContext), (state) => state.quotedDraft);
}

export function useMessageHighlighted(messageId: string): boolean {
  return useSelector(
    useContext(ConversationUiStoreContext),
    (state) => state.jumpHighlightId === messageId,
  );
}
