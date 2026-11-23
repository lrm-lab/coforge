import type { QueryClient } from "@tanstack/react-query";

import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { syncCommentsChange } from "./artifact-comment-queries";
import { artifactDataEvents } from "./artifact-page-data-events";
import { refreshArtifact } from "./artifact-queries";
import {
  decodeArtifactAccessChangedEvent,
  decodeArtifactCommentsChangedEvent,
  decodeArtifactDataChangedEvent,
  decodeArtifactVersionPublishedEvent,
} from "./artifact-realtime";

import { useOptionalInlineEmbedPool } from "./inline-embed-pool-context";

export function useArtifactPageRealtime({
  workspaceId,
  artifactId,
  homeId,
  latest,
  queryClient,
  keepSeen,
  onIncomingVersion,
}: {
  workspaceId: string | undefined;
  artifactId: string;
  homeId: string | null | undefined;
  latest: number;
  queryClient: QueryClient;
  keepSeen: () => void;
  onIncomingVersion: (version: number) => void;
}) {
  const embedPool = useOptionalInlineEmbedPool();
  useRealtimeSubscription({
    channel:
      homeId === undefined || !workspaceId
        ? undefined
        : homeId
          ? conversationRealtimeChannel(homeId)
          : workspaceConversationChannel(workspaceId),
    recoverable: true,
    positioned: true,
    onPublication: ({ data }) => {
      const commentsChange = decodeArtifactCommentsChangedEvent(data);
      if (commentsChange) {
        if (commentsChange.artifactId === artifactId) {
          void syncCommentsChange(queryClient, commentsChange);
          keepSeen();
        }
        return;
      }
      const dataChange = decodeArtifactDataChangedEvent(data);
      if (dataChange) {
        if (dataChange.artifactId === artifactId) artifactDataEvents.emit(dataChange);
        return;
      }
      const published = decodeArtifactVersionPublishedEvent(data);
      if (published?.artifactId === artifactId) {
        if (published.number > latest) onIncomingVersion(published.number);
        keepSeen();
        void refreshArtifact(queryClient, artifactId, homeId ?? null, { document: false });
        return;
      }
      if (decodeArtifactAccessChangedEvent(data)?.artifactId === artifactId) {
        embedPool?.evictArtifact(artifactId);
        void refreshArtifact(queryClient, artifactId, homeId ?? null);
      }
    },
  });
}
