import { useCallback, useEffect, useMemo } from "react";
import { getRouteApi, useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  decodeViewerEvent,
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  publicationDataOrUndefined,
  publicationType,
} from "#src/features/realtime/publication-data";
import {
  getUserConversationSubscriptionToken,
  getWorkspaceConversationSubscriptionToken,
} from "#src/features/realtime/realtime.functions";
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

// React access to the Tasks page's rows (`task-overview-collection.ts`).

const overviewsByClient = new WeakMap<QueryClient, Map<string, TaskOverviewCollection>>();

/** One overview (collection and commands) per `QueryClient` and Workspace, so every consumer
 * shares one sync and one optimistic state. */
function overviewFor(queryClient: QueryClient, workspaceId: string) {
  let byWorkspace = overviewsByClient.get(queryClient);
  if (!byWorkspace) overviewsByClient.set(queryClient, (byWorkspace = new Map()));
  let overview = byWorkspace.get(workspaceId);
  if (!overview)
    byWorkspace.set(workspaceId, (overview = createTaskOverview(queryClient, workspaceId)));
  return overview;
}

/**
 * The Tasks page's rows, how to run a command on one, and how to read them again. Server-rendered
 * from the Query cache the loader fills; after hydration read live from the collection.
 */
export function useTaskOverview() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // The server's list of Tasks, which and in what order. Structurally shared, so it re-renders
  // only when a read changes that list, not when a change rewrites a row in the cache: after
  // hydration the rows themselves come from the collection.
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
  // The rows in the order the server sent them, which a live query does not keep.
  const position = useMemo(() => new Map(order.map((id, index) => [id, index])), [order]);
  const liveRows = live.isReady ? live.data : undefined;
  const tasks: readonly OverviewTaskRow[] = useMemo(
    () =>
      liveRows
        ? [...liveRows].sort(
            (left, right) =>
              (position.get(left.id) ?? Infinity) -
              (position.get(right.id) ?? Infinity),
          )
        : // Until the live query is ready (the server render, the first tick after hydration) the
          // cache holds the same rows, already in order.
          (queryClient.getQueryData(taskOverviewQuery(workspaceId).queryKey)?.tasks ?? []),
    [liveRows, position, queryClient, workspaceId],
  );
  useTaskOverviewRealtime(overview, workspaceId);
  return useMemo(
    () => ({
      tasks,
      /** Undefined until hydrated: the server render offers no commands. */
      run: overview?.run,
      refetch: () =>
        queryClient.invalidateQueries({ queryKey: taskOverviewQuery(workspaceId).queryKey }),
    }),
    [tasks, overview, queryClient, workspaceId],
  );
}

/** Announcements arriving together (an Agent working through several Tasks) apply in one write. */
const APPLY_DELAY_MS = 100;

/**
 * Keeps the rows live: listens for `task.changed.v1` on the Workspace channel, where public
 * channels' Tasks are announced, and on the viewer's own channel for a private channel's
 * (`privateChannel`; a direct message's go there too, and this page does not list them), the
 * subscriptions the nav rail already holds, and applies each burst in one write. Every other
 * publication (every chat message) is dropped before any parsing beyond its type. Only a Task the
 * page does not list yet reads the list again, once per burst.
 */
function useTaskOverviewRealtime(
  overview: TaskOverviewCollection | undefined,
  workspaceId: string,
) {
  const queryClient = useQueryClient();
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  // One buffer per overview: a Workspace switch drops what the old one had not applied yet.
  const burst = useMemo(
    () => ({
      pending: [] as TaskChangedEvent[],
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }),
    [overview],
  );
  useEffect(() => () => clearTimeout(burst.timer), [burst]);

  const apply = useCallback(
    (event: TaskChangedEvent | undefined) => {
      if (!event || !overview || event.workspaceId !== workspaceId) return;
      burst.pending.push(event);
      if (burst.timer !== undefined) return;
      burst.timer = setTimeout(() => {
        burst.timer = undefined;
        const events = burst.pending.splice(0);
        // Done and Closed are counted and paged by the server: a change may move a Task into or
        // out of them, so their counts and opened pages are read again, once per burst.
        void queryClient.invalidateQueries({ queryKey: finishedTasksKey(workspaceId) });
        let needsRead: boolean;
        try {
          needsRead = overview.apply(events);
        } catch {
          // A change that cannot be applied is shown by a read of the list instead.
          needsRead = true;
        }
        // The collection keeps each applied change over a read that predates it.
        if (needsRead)
          void queryClient.invalidateQueries({ queryKey: taskOverviewQuery(workspaceId).queryKey });
      }, APPLY_DELAY_MS);
    },
    [overview, workspaceId, queryClient, burst],
  );
  const onWorkspacePublication = useCallback(
    (publication: { data: unknown }) => apply(decodeTaskChangedEvent(publication.data)),
    [apply],
  );
  const onUserPublication = useCallback(
    (publication: { data: unknown }) => {
      // Every message's activity rides this channel too: it leaves on its type, parsed once.
      const data = publicationDataOrUndefined(publication.data);
      const type = publicationType(data);
      if (type === "task.changed.v1") {
        const event = decodeTaskChangedEvent(data);
        if (event?.privateChannel) apply(event);
        return;
      }
      // The viewer joined or left a channel: a private one's Tasks come or go with it, which only
      // a read of the list says.
      if (
        (type === "channel.joined.v1" || type === "channel.left.v1") &&
        decodeViewerEvent(data)?.workspaceId === workspaceId
      )
        void queryClient.invalidateQueries({ queryKey: taskOverviewQuery(workspaceId).queryKey });
    },
    [apply, queryClient, workspaceId],
  );

  useRealtimeSubscription({
    channel: overview && workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    getToken: getWorkspaceToken,
    onPublication: onWorkspacePublication,
  });
  useRealtimeSubscription({
    channel: overview ? userConversationChannel(userId) : undefined,
    getToken: getUserToken,
    onPublication: onUserPublication,
  });
}
