import { useQueryClient } from "@tanstack/react-query";

import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { decodeArtifactSettlementChangedEvent } from "./artifact-realtime";
import { refreshArtifact } from "./artifact-queries";

export function ArtifactSettlementRealtime({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  useRealtimeSubscription({
    channel: workspaceConversationChannel(workspaceId),
    onPublication: ({ data }) => {
      const event = decodeArtifactSettlementChangedEvent(data);
      if (!event || event.workspaceId !== workspaceId) return;
      void refreshArtifact(queryClient, event.artifactId, null);
    },
  });
  return null;
}
