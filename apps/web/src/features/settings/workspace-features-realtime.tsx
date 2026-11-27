import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { decodeWorkspaceFeaturesChangedEvent } from "#src/features/workspaces/workspace-realtime";
import { AI_WORKBENCH_QUERY_KEY } from "./ai-workbench";
import {
  invalidateWeeklyReportsDependents,
  WEEKLY_REPORTS_QUERY_KEY,
} from "#src/features/records/weekly-reports-gate";

export function WorkspaceFeaturesRealtime({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  useRealtimeSubscription({
    channel: workspaceConversationChannel(workspaceId),
    onPublication: useCallback(
      (publication: { data: unknown }) => {
        if (decodeWorkspaceFeaturesChangedEvent(publication.data)?.workspaceId !== workspaceId) {
          return;
        }
        void queryClient.invalidateQueries({ queryKey: WEEKLY_REPORTS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: AI_WORKBENCH_QUERY_KEY });
        invalidateWeeklyReportsDependents(queryClient, workspaceId);
        void router.invalidate();
      },
      [queryClient, router, workspaceId],
    ),
  });
  return null;
}
