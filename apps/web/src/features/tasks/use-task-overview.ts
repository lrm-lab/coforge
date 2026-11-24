import { useCallback, useEffect, useMemo, useRef } from "react";
import { getRouteApi, useHydrated } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  decodeViewerEvent,
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { channelSignalOf } from "#src/features/conversations/conversation-unread";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import {
  createTaskOverview,
  taskOverviewQuery,
  type OverviewTaskRow,
  type TaskOverviewCollection,
} from "./task-overview-collection";
import { decodeTaskChangedEvent, type TaskChangedEvent } from "./task-realtime";
import { finishedTasksKey } from "./use-finished-tasks";

const appRoute = getRouteApi("/w/$workspaceSlug");

const selectOrder = (overview: { tasks: readonly { id: string }[] }) =>
  overview.tasks.map((task) => task.id);

const overviewsByClient = new WeakMap<QueryClient, Map<string, TaskOverviewCollection>>();

function overviewFor(queryClient: QueryClient, workspaceId: string) {
  let byWorkspace = overviewsByClient.get(queryClient);
  if (!byWorkspace) overviewsByClient.set(queryClient, (byWorkspace = new Map()));
  let overview = byWorkspace.get(workspaceId);
  if (!overview)
    byWorkspace.set(workspaceId, (overview = createTaskOverview(queryClient, workspaceId)));
  return overview;
}

export function useTaskOverview() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const order = useSuspenseQuery({
    ...taskOverviewQuery(workspaceId),
    select: selectOrder,
    notifyOnChangeProps: ["data"],
  }).data;
  const hydrated = useHydrated();
  const overview = useMemo(
    () => (hydrated ? overviewFor(queryClient, workspaceId) : undefined),
    [hydrated, queryClient, workspaceId],
  );
  const live = useLiveQuery({
    queryKey: ["task-overview", workspaceId, Boolean(overview)],
    query: (q) => (overview ? q.from({ task: overview.tasks }) : undefined),
  });
  const position = useMemo(() => new Map(order.map((id, index) => [id, index])), [order]);
  const liveRows = live.isReady ? live.data : undefined;
  const tasks: readonly OverviewTaskRow[] = useMemo(
    () =>
      liveRows
        ? [...liveRows].sort(
            (left, right) =>
              (position.get(left.id) ?? Infinity) - (position.get(right.id) ?? Infinity),
          )
        : (queryClient.getQueryData(taskOverviewQuery(workspaceId).queryKey)?.tasks ?? []),
    [liveRows, position, queryClient, workspaceId],
  );
  useTaskOverviewRealtime(overview, workspaceId);
  return useMemo(
    () => ({
      tasks,
      run: overview?.run,
      refetch: () =>
        queryClient.invalidateQueries({ queryKey: taskOverviewQuery(workspaceId).queryKey }),
    }),
    [tasks, overview, queryClient, workspaceId],
  );
}

const APPLY_DELAY_MS = 100;

function useTaskOverviewRealtime(
  overview: TaskOverviewCollection | undefined,
  workspaceId: string,
) {
  const queryClient = useQueryClient();
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const burstRef = useRef<{
    pending: TaskChangedEvent[];
    timer: ReturnType<typeof setTimeout> | undefined;
  }>({ pending: [], timer: undefined });
  useEffect(
    () => () => {
      clearTimeout(burstRef.current.timer);
      burstRef.current.timer = undefined;
      burstRef.current.pending = [];
    },
    [overview],
  );

  const apply = useCallback(
    (event: TaskChangedEvent | undefined) => {
      if (!event || !overview || event.workspaceId !== workspaceId) return;
      const burst = burstRef.current;
      burst.pending.push(event);
      if (burst.timer !== undefined) return;
      burst.timer = setTimeout(() => {
        burst.timer = undefined;
        const events = burst.pending;
        burst.pending = [];
        void queryClient.invalidateQueries({ queryKey: finishedTasksKey(workspaceId) });
        let needsRead: boolean;
        try {
          needsRead = overview.apply(events);
        } catch {
          needsRead = true;
        }
        if (needsRead)
          void queryClient.invalidateQueries({ queryKey: taskOverviewQuery(workspaceId).queryKey });
      }, APPLY_DELAY_MS);
    },
    [overview, workspaceId, queryClient],
  );
  const readAgain = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: taskOverviewQuery(workspaceId).queryKey });
    void queryClient.invalidateQueries({ queryKey: finishedTasksKey(workspaceId) });
  }, [queryClient, workspaceId]);
  const onWorkspacePublication = useCallback(
    (publication: { data: unknown }) => {
      const data = publicationDataOrUndefined(publication.data);
      if (publicationType(data) === "channel.created.v1") {
        if (channelSignalOf(data)?.workspaceId === workspaceId) readAgain();
        return;
      }
      apply(decodeTaskChangedEvent(data));
    },
    [apply, readAgain, workspaceId],
  );
  const onUserPublication = useCallback(
    (publication: { data: unknown }) => {
      const data = publicationDataOrUndefined(publication.data);
      const type = publicationType(data);
      if (type === "task.changed.v1") {
        apply(decodeTaskChangedEvent(data));
        return;
      }
      if (
        (type === "channel.joined.v1" || type === "channel.left.v1") &&
        decodeViewerEvent(data)?.workspaceId === workspaceId
      )
        readAgain();
      if (type === "channel.updated.v1") {
        const signal = channelSignalOf(data);
        if (signal?.workspaceId === workspaceId && "gone" in signal && signal.gone) readAgain();
      }
    },
    [apply, readAgain, workspaceId],
  );

  useRealtimeSubscription({
    channel: overview && workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication: onWorkspacePublication,
  });
  useRealtimeSubscription({
    channel: overview ? userConversationChannel(userId) : undefined,
    onPublication: onUserPublication,
  });
}
