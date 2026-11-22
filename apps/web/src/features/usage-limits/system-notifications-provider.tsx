import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, use, useMemo, type PropsWithChildren } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";

import { decodeUsageLimitChangedEvent } from "./usage-limit-events";
import {
  markNotices,
  unseenNotices,
  visibleNotices,
  type UsageLimitNotice,
} from "./usage-limit-notices";
import {
  dismissUsageLimitEvent,
  getUsageLimitEvents,
  seenUsageLimitEvent,
} from "./usage-limits.functions";

const usageLimitsQuery = (workspaceId: string | undefined, enabled: boolean) =>
  queryOptions({
    queryKey: ["usage-limit-events", workspaceId],
    queryFn: (): Promise<UsageLimitNotice[]> => getUsageLimitEvents(),
    enabled: enabled && workspaceId !== undefined,
  });

type SystemNotifications = {
  notices: readonly UsageLimitNotice[];
  unseen: number;
  loading: boolean;
  failed: boolean;
  retrying: boolean;
  retry: () => void;
  markSeen: (ids: readonly string[]) => void;
  dismiss: (id: string) => void;
};

const NO_NOTIFICATIONS: SystemNotifications = {
  notices: [],
  unseen: 0,
  loading: false,
  failed: false,
  retrying: false,
  retry: () => {},
  markSeen: () => {},
  dismiss: () => {},
};

const SystemNotificationsContext = createContext<SystemNotifications>(NO_NOTIFICATIONS);

export const useSystemNotifications = () => use(SystemNotificationsContext);

export function SystemNotificationsProvider({
  viewerId,
  enabled,
  children,
}: PropsWithChildren<{ viewerId: string; enabled: boolean }>) {
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  const options = usageLimitsQuery(workspaceId, enabled);
  const { queryKey } = options;
  const query = useQuery(options);
  useRealtimeSubscription({
    channel: enabled ? userConversationChannel(viewerId) : undefined,
    onSubscribed: () => void queryClient.invalidateQueries({ queryKey }),
    onPublication: ({ data }) => {
      const event = decodeUsageLimitChangedEvent(data);
      if (event?.workspaceId === workspaceId) void queryClient.invalidateQueries({ queryKey });
    },
  });
  const value = useMemo(() => {
    if (!enabled) return NO_NOTIFICATIONS;
    const mark = (
      ids: readonly string[],
      field: "seenAt" | "dismissedAt",
      save: (id: string) => Promise<unknown>,
    ) => {
      queryClient.setQueryData<UsageLimitNotice[]>(
        queryKey,
        (current) => current && markNotices(current, ids, field, new Date()),
      );
      Promise.all(ids.map(save)).catch(() => queryClient.invalidateQueries({ queryKey }));
    };
    const all = query.data ?? [];
    return {
      notices: visibleNotices(all),
      unseen: unseenNotices(all).length,
      loading: query.isPending && query.fetchStatus === "fetching",
      failed: query.isError && query.data === undefined,
      retrying: query.isRefetching,
      retry: () => {
        void query.refetch();
      },
      markSeen: (ids: readonly string[]) =>
        mark(ids, "seenAt", (eventId) => seenUsageLimitEvent({ data: { eventId } })),
      dismiss: (id: string) =>
        mark([id], "dismissedAt", (eventId) => dismissUsageLimitEvent({ data: { eventId } })),
    };
  }, [
    enabled,
    query.data,
    query.fetchStatus,
    query.isError,
    query.isPending,
    query.isRefetching,
    query.refetch,
    queryClient,
    queryKey,
  ]);
  return <SystemNotificationsContext value={value}>{children}</SystemNotificationsContext>;
}
