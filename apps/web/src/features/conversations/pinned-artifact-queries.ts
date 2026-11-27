import { useCallback, useSyncExternalStore } from "react";
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { refreshArtifact } from "#src/features/artifacts/artifact-queries";
import {
  decodeArtifactAccessChangedEvent,
  decodeArtifactSettlementChangedEvent,
  decodeArtifactVersionPublishedEvent,
} from "#src/features/artifacts/artifact-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import type { ConversationPinnedArtifactView } from "#src/server/conversations/conversation-pinned-artifact.server";
import {
  conversationRealtimeChannel,
  decodeConversationPinnedArtifactChangedEvent,
} from "./conversation-realtime";
import {
  loadConversationPinnedArtifact,
  updateConversationPinnedArtifact,
} from "./conversation-pinned-artifact.functions";
import {
  isPinnedArtifactDismissed,
  readPinnedDismissal,
  writePinnedDismissal,
  type PinnedArtifactDismissal,
} from "./pinned-artifact-dismiss";

const PINNED_ARTIFACT_KEY = ["conversation-pinned-artifact"] as const;

const conversationPinnedArtifactQuery = (conversationId: string) =>
  queryOptions({
    queryKey: [...PINNED_ARTIFACT_KEY, conversationId],
    queryFn: () => loadConversationPinnedArtifact({ data: { conversationId } }),
    staleTime: 30_000,
  });

function invalidateConversationPinnedArtifact(queryClient: QueryClient, conversationId: string) {
  return queryClient.invalidateQueries({
    queryKey: [...PINNED_ARTIFACT_KEY, conversationId],
  });
}

export function markPinnedArtifactSeenInCache(
  queryClient: QueryClient,
  artifactId: string,
  version: number,
) {
  queryClient.setQueriesData<ConversationPinnedArtifactView>(
    { queryKey: [...PINNED_ARTIFACT_KEY] },
    (current) => {
      if (!current?.pinned) return current;
      if (current.pinned.artifactId !== artifactId) return current;
      if (current.pinned.seen || version < current.pinned.version) return current;
      return { ...current, pinned: { ...current.pinned, seen: true } };
    },
  );
}

const dismissalListeners = new Set<() => void>();
const dismissalCache = new Map<string, PinnedArtifactDismissal | null>();

function emitDismissalChange() {
  for (const listener of dismissalListeners) listener();
}

function subscribeDismissal(listener: () => void) {
  dismissalListeners.add(listener);
  return () => {
    dismissalListeners.delete(listener);
  };
}

function snapshotDismissal(conversationId: string): PinnedArtifactDismissal | null {
  if (!dismissalCache.has(conversationId)) {
    dismissalCache.set(conversationId, readPinnedDismissal(conversationId));
  }
  return dismissalCache.get(conversationId) ?? null;
}

function setPinnedDismissal(conversationId: string, dismissal: PinnedArtifactDismissal | null) {
  dismissalCache.set(conversationId, dismissal);
  writePinnedDismissal(conversationId, dismissal);
  emitDismissalChange();
}

function usePinnedDismissal(conversationId: string) {
  const dismissal = useSyncExternalStore(
    subscribeDismissal,
    () => snapshotDismissal(conversationId),
    () => null,
  );
  const dismiss = useCallback(
    (artifactId: string, version: number) => {
      setPinnedDismissal(conversationId, { artifactId, version });
    },
    [conversationId],
  );
  const restore = useCallback(() => {
    setPinnedDismissal(conversationId, null);
  }, [conversationId]);
  return { dismissal, dismiss, restore };
}

export function useConversationPinnedArtifact(
  conversationId: string,
  options: { enabled?: boolean; subscribe?: boolean } = {},
) {
  const enabled = options.enabled ?? true;
  const subscribe = options.subscribe ?? false;
  const queryClient = useQueryClient();
  const query = useQuery({
    ...conversationPinnedArtifactQuery(conversationId),
    enabled,
  });
  const pinnedArtifactId = query.data?.pinned?.artifactId ?? null;

  useRealtimeSubscription({
    channel: enabled && subscribe ? conversationRealtimeChannel(conversationId) : undefined,
    recoverable: true,
    positioned: true,
    onPublication: ({ data }) => {
      const pinChanged = decodeConversationPinnedArtifactChangedEvent(data);
      if (pinChanged?.conversationId === conversationId) {
        void invalidateConversationPinnedArtifact(queryClient, conversationId);
        return;
      }
      const settlementChanged = decodeArtifactSettlementChangedEvent(data);
      if (settlementChanged) {
        void refreshArtifact(queryClient, settlementChanged.artifactId, conversationId);
        if (settlementChanged.artifactId === pinnedArtifactId) {
          void invalidateConversationPinnedArtifact(queryClient, conversationId);
        }
        return;
      }
      if (!pinnedArtifactId) return;
      const published = decodeArtifactVersionPublishedEvent(data);
      if (published?.artifactId === pinnedArtifactId) {
        void invalidateConversationPinnedArtifact(queryClient, conversationId);
        return;
      }
      const accessChanged = decodeArtifactAccessChangedEvent(data);
      if (accessChanged?.artifactId === pinnedArtifactId) {
        void invalidateConversationPinnedArtifact(queryClient, conversationId);
      }
    },
  });

  const { dismissal, dismiss, restore } = usePinnedDismissal(conversationId);
  const dismissed = isPinnedArtifactDismissed(query.data?.pinned, dismissal);

  const setPinned = useCallback(
    async (artifactId: string | null) => {
      const next = await updateConversationPinnedArtifact({
        data: { conversationId, artifactId },
      });
      queryClient.setQueryData(conversationPinnedArtifactQuery(conversationId).queryKey, next);
      if (artifactId !== null) setPinnedDismissal(conversationId, null);
      return next;
    },
    [conversationId, queryClient],
  );

  return {
    data: query.data,
    isLoading: query.isLoading,
    pinned: query.data?.pinned ?? null,
    canEdit: query.data?.canEdit ?? false,
    dismissed,
    dismiss,
    restore,
    setPinned,
  };
}
