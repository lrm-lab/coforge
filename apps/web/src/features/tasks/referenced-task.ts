import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { isAppErrorCode } from "#src/lib/app-error";
import { decodeTaskChangedEvent } from "./task-realtime";
import { loadConversationTasks } from "./tasks.functions";
import { conversationTaskReadsKey } from "./use-finished-tasks";

/**
 * A direct message's Task, read as its Tasks tab reads them; `null` when the viewer is not in that
 * direct message (or it has no such Task). A channel's is `overviewTaskQuery`, which reads only
 * channels; both sit under `conversationTaskReadsKey`, which a change to the conversation's Tasks
 * reads again.
 */
export const directTaskQuery = (
  workspaceId: string,
  task: { conversationId: string; number: number },
) =>
  queryOptions({
    queryKey: [
      ...conversationTaskReadsKey(workspaceId, task.conversationId),
      task.number,
      "direct",
    ],
    // A change while realtime was away is read on its return, as the finished-work reads are.
    refetchOnReconnect: "always",
    queryFn: async () => {
      try {
        const { tasks } = await loadConversationTasks({
          data: { conversationId: task.conversationId, numbers: [task.number] },
        });
        return tasks.find((each) => each.number === task.number) ?? null;
      } catch (cause) {
        if (isAppErrorCode(cause, "ACCESS_DENIED", "NOT_FOUND")) return null;
        throw cause;
      }
    },
  });

/**
 * Keeps every referenced Task's badge live, whichever conversation is open: a `task.changed.v1`
 * reads again the references to the Tasks it changed (a deleted one names only its message, so all
 * of its conversation's). The subscriptions are the ones the nav rail already holds — the
 * Workspace channel for public channels' Tasks, the viewer's own for private channels' and direct
 * messages'.
 */
export function ReferencedTasksRealtime({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const onPublication = useCallback(
    (publication: { data: unknown }) => {
      const event = decodeTaskChangedEvent(publication.data);
      if (!event || event.workspaceId !== workspaceId) return;
      const conversation = conversationTaskReadsKey(workspaceId, event.conversationId);
      // A deletion names only its message: every read of the conversation's Tasks goes again.
      if (event.deleted.length > 0) {
        void queryClient.invalidateQueries({ queryKey: conversation });
        return;
      }
      const numbers = new Set(event.tasks.map((task) => task.number));
      void queryClient.invalidateQueries({
        queryKey: conversation,
        predicate: (query) => numbers.has(query.queryKey[conversation.length] as number),
      });
    },
    [queryClient, workspaceId],
  );
  useRealtimeSubscription({ channel: workspaceConversationChannel(workspaceId), onPublication });
  useRealtimeSubscription({ channel: userConversationChannel(userId), onPublication });
  return null;
}
