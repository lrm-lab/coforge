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
  markSeen: (ids: readonly string[]) => void;
  dismiss: (id: string) => void;
};

const SystemNotificationsContext = createContext<SystemNotifications | null>(null);

/** The bell's data, or null for a viewer who has no notifications to see. */
export const useSystemNotifications = () => use(SystemNotificationsContext);

/**
 * The system notifications of the Workspace for an owner or admin (task #641): today usage-limit
 * events. Any change on the viewer's own channel, or a gap in it, rereads the list.
 */
export function SystemNotificationsProvider({
  viewerId,
  enabled,
  children,
}: PropsWithChildren<{ viewerId: string; enabled: boolean }>) {
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  const query = usageLimitsQuery(workspaceId, enabled);
  const { queryKey } = query;
  const events = useQuery(query).data;
  useRealtimeSubscription({
    channel: enabled ? userConversationChannel(viewerId) : undefined,
    onSubscribed: () => void queryClient.invalidateQueries({ queryKey }),
    onPublication: ({ data }) => {
      const event = decodeUsageLimitChangedEvent(data);
      if (event?.workspaceId === workspaceId) void queryClient.invalidateQueries({ queryKey });
    },
  });
  const value = useMemo(() => {
    if (!enabled) return null;
    // A mark shows at once; a failed save rereads what the server holds.
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
    const all = events ?? [];
    return {
      notices: visibleNotices(all),
      unseen: unseenNotices(all).length,
      markSeen: (ids: readonly string[]) =>
        mark(ids, "seenAt", (eventId) => seenUsageLimitEvent({ data: { eventId } })),
      dismiss: (id: string) =>
        mark([id], "dismissedAt", (eventId) => dismissUsageLimitEvent({ data: { eventId } })),
    };
  }, [enabled, events, queryClient, queryKey]);
  return <SystemNotificationsContext value={value}>{children}</SystemNotificationsContext>;
}
