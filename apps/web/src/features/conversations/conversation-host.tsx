import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDbClient } from "@tanstack/react-db";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ForwardHost } from "./message-forward-host";
import { savedMessagesQuery } from "./conversation-queries";
import type { ChannelSuggestion } from "./reference-completion";
import { listSavedMessages, saveMessage, unsaveMessage } from "./saved-messages.functions";
import {
  materializeSavedMessages,
  savedMessagesStore,
  type SavedEntry,
  type SavedMessagesStore,
} from "./saved-messages-collection";

/** The viewer's Saved list (#127), one TanStack DB collection behind the row stars, the sidebar
 * entry, and the Saved view (`saved-messages-collection.ts`). Saves and unsaves show at once and
 * roll back when the server refuses them. */
type SavedMessagesState = {
  store: SavedMessagesStore;
  /** Resolves once the server has the save; rejects (after rolling back) when it fails. */
  save: (saved: SavedEntry) => Promise<void>;
  unsave: (messageId: string) => Promise<void>;
};

const SavedMessagesContext = createContext<SavedMessagesState | null>(null);
const ChannelsContext = createContext<readonly ChannelSuggestion[] | undefined>(undefined);

/**
 * What a conversation reads from the page hosting it (Chat, or the hosted pane): the viewer's
 * Saved list and the Workspace's channels. The sidebar's unread badges stay Chat's own.
 */
export function ConversationHostProvider({
  channels,
  children,
}: {
  channels: readonly ChannelSuggestion[];
  children: ReactNode;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Saved (#127): one collection on the app's `DbClient` (`DbClient.collection` keeps one per id),
  // shared by every host: it starts from the list the host's loader put in the Query cache,
  // follows its Query, and a toggle changes it at once and persists in the background. A host is
  // only ever rendered in the browser (TanStack DB collections are client-side only).
  const dbClient = useDbClient();
  const queryClient = useQueryClient();
  const savedMessages = useMemo<SavedMessagesState>(() => {
    const cached = () =>
      queryClient.getQueryData(savedMessagesQuery(workspaceId).queryKey)?.entries ?? [];
    const store = savedMessagesStore(
      materializeSavedMessages(dbClient, workspaceId, cached(), {
        list: () => listSavedMessages(),
        save: (target) => saveMessage({ data: target }),
        unsave: (target) => unsaveMessage({ data: target }),
      }),
      cached,
    );
    return { store, save: store.save, unsave: store.unsave };
  }, [dbClient, queryClient, workspaceId]);
  return (
    <SavedMessagesContext value={savedMessages}>
      <ChannelsContext value={channels}>
        <ForwardHost channels={channels}>{children}</ForwardHost>
      </ChannelsContext>
    </SavedMessagesContext>
  );
}

/** The Workspace's channels from the hosting page; undefined outside a conversation host. */
export function useConversationHostChannels(): readonly ChannelSuggestion[] | undefined {
  return useContext(ChannelsContext);
}

/** The Saved list controls; null where no conversation host is above (rows then offer no save). */
export function useSavedMessages(): SavedMessagesState | null {
  return useContext(SavedMessagesContext);
}

const NO_SAVED_ENTRIES: SavedEntry[] = [];
const noSubscription = () => () => {};

/** The Saved list, newest save first; undefined where no conversation host is above. */
export function useSavedEntries(): SavedEntry[] | undefined {
  const saved = useContext(SavedMessagesContext);
  const entries = useSyncExternalStore(
    saved?.store.subscribe ?? noSubscription,
    () => saved?.store.entries() ?? NO_SAVED_ENTRIES,
    () => saved?.store.entries() ?? NO_SAVED_ENTRIES,
  );
  return saved ? entries : undefined;
}

/** Whether one message is saved; a row re-renders only when its own answer changes. */
export function useIsMessageSaved(messageId: string): boolean {
  const saved = useContext(SavedMessagesContext);
  return useSyncExternalStore(
    saved?.store.subscribe ?? noSubscription,
    () => saved?.store.has(messageId) ?? false,
    () => saved?.store.has(messageId) ?? false,
  );
}
