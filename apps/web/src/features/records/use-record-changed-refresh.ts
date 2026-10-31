import { useRef } from "react";
import { getRouteApi } from "@tanstack/react-router";

import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { missedBySubscribe, type StreamPositions } from "#src/features/realtime/subscription-gap";
import { decodeRecordChangedEvent } from "./record-realtime";
import { useRecordRefresh } from "./use-record-refresh";

const appRoute = getRouteApi("/w/$workspaceSlug");

/**
 * While `active` (the page shows the report's key points), reads the report again whenever the
 * server says it changed where the page cannot see it (`record.changed.v1`: its key points started,
 * finished or failed), on the viewer's own channel. A subscribe that may have missed one, judged
 * by where the viewer's channel stood when the report was read (`streamPositions`), reads it too.
 * Only the report's own route reloads, not the catalog or the Workspace around it.
 */
export function useRecordChangedRefresh(
  reportId: string,
  streamPositions: StreamPositions | undefined,
  active: boolean,
) {
  const viewerId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const refresh = useRecordRefresh();
  const channel = userConversationChannel(viewerId);
  const readPosition = useRef(streamPositions);
  readPosition.current = streamPositions;
  useRealtimeSubscription({
    channel: active ? channel : undefined,
    onPublication: (publication) => {
      if (decodeRecordChangedEvent(publication.data)?.reportId === reportId) void refresh.record();
    },
    onSubscribed: (recovery) => {
      void missedBySubscribe(recovery, () => readPosition.current?.[channel])
        .then((missed) => {
          if (missed) void refresh.record();
        })
        .catch(() => {});
    },
  });
}
