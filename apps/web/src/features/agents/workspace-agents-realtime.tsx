import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useSelector, type Store } from "@tanstack/react-store";
import { useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { listAgents } from "./agents.functions";
import { listStatusAgents } from "./workspace-agents.functions";
import { useAgentStatuses, type AgentStatusView } from "./agent-status-realtime";
import { agentById, LiveAgentStoreContext, StatusOnlyDisplaysContext } from "./agent-status-floor";
import { useStatusAgents } from "./use-status-agents";
import type { StreamPositions } from "#src/features/realtime/subscription-gap";
import {
  activityInConversation,
  RECENT_ACTIVITY_LIMIT,
  type ActivityEntry,
} from "./agent-activity";
import { type AgentVisibility } from "./agent-visibility";
import {
  agentActivityFeedQuery,
  useWorkspaceActivityRealtime,
  workspaceActivityQuery,
  type RecentActivityByAgent,
} from "./agent-activity-queries";
import { agentModelsQueryKey } from "./agent-models";
import { useAgentTokenUsageInvalidator } from "./agent-token-usage-queries";
import type { AgentMascot } from "./agent-mascot";
import type { ExtraAgent } from "./extra-agent";
import { loadExtraAgents } from "./extra-agents.functions";
import {
  useAgentDirectoryInvalidator,
  useRefreshAfterAgentWrite,
  extraAgentsQueryKey,
  extraLiveAgent,
  refreshedAgents,
  useLatestRoster,
} from "./workspace-agents-refresh";
import { heldDisplayAgentIds } from "./extra-agents-held";
import { createDisplayWatchRegistry, DisplayWatcherContext } from "./watched-agent-displays";
import { createReplyIntentStore } from "./reply-intents";
import { ReplyIntentStoreProvider } from "./reply-intents-context";
import { useUserChannelReplyIntents } from "./reply-intents-realtime";

export {
  resolveAgentDisplay,
  selectExtraWatchId,
  selectLiveAgentDisplay,
  useHasLiveAgent,
  useLiveAgentDisplay,
  useLiveAgentIdentity,
  useLiveAgentOnline,
  useLiveAgentProfileMetrics,
  useVisibleAgentDisplay,
} from "./agent-status-floor";

const EMPTY_ACTIVITY: ActivityEntry[] = [];

export type LiveAgent = {
  id: string;
  name: string;
  displayName: string;
  avatarUrl?: string | null;
  /** The mascot the Agent shows (`agentMascot`). Optional like `avatarUrl`: an Agent
   * shape from a path that never set it reads as the mascot its id chooses. */
  mascot?: AgentMascot;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
  /** Optional: an Agent shape that predates this field (or came from a path that never
   * set it) reads as `"public"`, matching the same fail-open default the create/list paths use
   * for Agents created before visibility existed. */
  visibility?: AgentVisibility;
  /** Set only on an Agent visible to the viewer but outside their own `listAgents` roster
   * (`extraLiveAgent`): its name, mascot and display, no description, so `useLiveAgents()` (the
   * Members directory, mention list) filters it out; `useLiveAgent(id)` still returns it so the
   * profile panel gets its live status/Activity, `useLiveWorkspaceAgents` returns it for the chat
   * list header, and `useVisibleLiveAgents` for the DM sidebar and the replying line. */
  isExtra?: true;
};

// Both contexts are module-private: everything outside reads them through the
// hooks below, so a consumer can never reach in and subscribe on its own. The live Agents are a
// TanStack Store rather than a context value, so a reader of one Agent (a message's avatar) is
// told when that Agent changes and not when any other does.
const WorkspaceIdContext = createContext<string | undefined>(undefined);
const RefreshAgentDirectoryContext = createContext<(() => Promise<void>) | null>(null);

/**
 * Owns the app shell's one Agent status subscription and one Activity
 * subscription, and shares both through context. Must be rendered inside
 * `BrowserRealtimeProvider` — the subscription hooks it calls throw when no
 * realtime client is above them — so mounting it anywhere else fails loudly
 * instead of silently never subscribing.
 */
export function WorkspaceAgentsProvider({
  workspaceId,
  viewerId,
  agents,
  extraAgents: loadedExtras,
  statusAgents: loadedStatusAgents,
  agentStreamPositions,
  children,
}: {
  workspaceId?: string;
  /** The signed-in person, whose own channel carries the reply intents of their direct messages. */
  viewerId?: string;
  agents: LiveAgent[];
  /** The extras the page loaded with the roster, so the first paint already lists a DM with
   * another member's Agent; absent when that read failed, and the browser reads them then. */
  extraAgents?: ExtraAgent[];
  /** Every live Agent's id and Computer in the Workspace (`statusAgentScopes`), whatever the
   * viewer may see: which Agents may report a status floor on the shared status channel. */
  statusAgents?: { id: string; computerId: string | null }[];
  /** Where the page's Agent reads stood in the status stream (`loadWorkspaceAgents`). */
  agentStreamPositions?: StreamPositions;
  children: ReactNode;
}) {
  const refreshAgents = useServerFn(listAgents);
  const refreshStatusAgents = useServerFn(listStatusAgents);
  const loadExtras = useServerFn(loadExtraAgents);
  const queryClient = useQueryClient();
  const liveAgentsStoreRef = useRef<Store<LiveAgent[]> | null>(null);
  const watched = useMemo(() => {
    let rereadQueued = false;
    return createDisplayWatchRegistry((agentId) => {
      const known = agentById(liveAgentsStoreRef.current?.state ?? [], agentId);
      if (known && (!known.isExtra || known.display)) return;
      if (rereadQueued) return;
      rereadQueued = true;
      queueMicrotask(() => {
        rereadQueued = false;
        void queryClient.invalidateQueries({ queryKey: extraAgentsQueryKey(workspaceId) });
      });
    });
  }, [queryClient, workspaceId]);
  const readExtraAgents = useCallback(
    (fullDisplays = false) =>
      loadExtras({
        data: {
          heldAgentIds: heldDisplayAgentIds(
            liveAgentsStoreRef.current?.state ?? [],
            Date.now(),
            watched.ids(),
          ),
          ...(fullDisplays ? { fullDisplays: true } : {}),
        },
      }),
    [loadExtras, watched],
  );
  const directoryInvalidator = useAgentDirectoryInvalidator();
  const tokenUsageInvalidator = useAgentTokenUsageInvalidator(workspaceId);

  // The Agents visible to this viewer beyond their own `listAgents` roster (another member's
  // public Agents, and, for an owner/admin or a private Agent's creator, private ones): each is a
  // named entry the status publications update in place, and a private one gets its per-Agent
  // subscriptions. `refreshWithExtras` below reads them again with the roster on every gap,
  // directory or visibility event and display expiry `useAgentStatuses` handles; the query's own
  // refetch covers focus and reconnect.
  const extraAgentsQuery = useQuery({
    queryKey: extraAgentsQueryKey(workspaceId),
    queryFn: workspaceId ? () => readExtraAgents() : skipToken,
    initialData: loadedExtras,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    notifyOnChangeProps: ["data"],
  });
  const extraAgents = useMemo(
    () => (extraAgentsQuery.data ?? []).map(extraLiveAgent),
    [extraAgentsQuery.data],
  );
  const [latestRoster, keepRoster] = useLatestRoster(agents, workspaceId);
  const { statusAgentIds, keepStatusAgents } = useStatusAgents(loadedStatusAgents, workspaceId);
  const refreshWithExtras = useCallback(async (): Promise<LiveAgent[]> => {
    const [roster, extras, statusAgents] = await Promise.all([
      refreshAgents(),
      workspaceId
        ? queryClient
            .fetchQuery({
              queryKey: extraAgentsQueryKey(workspaceId),
              // `refresh` runs on subscribe catch-up and the directory/visibility/expiry events —
              // the moments the extras' displays may be stale, so it reads them all (public ones;
              // `listExtraAgents` keeps private Agents on the busy/held rule).
              queryFn: () => readExtraAgents(true),
              staleTime: 0,
            })
            // The extras are an addition: without a fresh read the last ones read stay.
            .catch(() => queryClient.getQueryData<ExtraAgent[]>(extraAgentsQueryKey(workspaceId)))
        : undefined,
      // The status set is an addition too: a failed read keeps the last one.
      workspaceId ? refreshStatusAgents().catch(() => undefined) : undefined,
    ]);
    keepRoster(workspaceId, roster);
    if (statusAgents) keepStatusAgents(workspaceId, statusAgents);
    return refreshedAgents(roster, extras);
  }, [
    refreshAgents,
    refreshStatusAgents,
    readExtraAgents,
    queryClient,
    workspaceId,
    keepRoster,
    keepStatusAgents,
  ]);

  const {
    agentsStore: liveAgents,
    statusOnlyStore,
    privateAgentIds,
    refresh: refreshDirectory,
  } = useAgentStatuses<LiveAgent>({
    agents: latestRoster,
    workspaceId,
    refresh: refreshWithExtras,
    extraAgents,
    statusOnlyAgentIds: statusAgentIds.size > 0 ? statusAgentIds : undefined,
    readPositions: agentStreamPositions,
    onVisibilityChangedEvent: workspaceId
      ? () => {
          void queryClient.invalidateQueries({ queryKey: agentModelsQueryKey(workspaceId) });
          directoryInvalidator.schedule();
        }
      : undefined,
    onDirectoryChangedEvent: directoryInvalidator.schedule,
    onTokenUsageRecordedEvent: workspaceId
      ? (agentId) => {
          if (agentId) tokenUsageInvalidator.schedule(agentId);
          else tokenUsageInvalidator.scheduleAll();
        }
      : undefined,
  });

  useLayoutEffect(() => {
    liveAgentsStoreRef.current = liveAgents;
  }, [liveAgents]);

  const replyIntents = useMemo(() => createReplyIntentStore(), [workspaceId]);
  useEffect(() => () => replyIntents.clear(), [replyIntents]);
  useWorkspaceActivityRealtime(workspaceId, privateAgentIds, viewerId);
  useUserChannelReplyIntents(workspaceId, viewerId, replyIntents);

  useEffect(() => {
    if (!workspaceId) return;
    let previousIds: Set<string> | undefined;
    const prune = (currentAgents: readonly LiveAgent[]) => {
      const visibleIds = new Set(currentAgents.map((agent) => agent.id));
      if (previousIds && previousIds.size === visibleIds.size) {
        let same = true;
        for (const id of visibleIds) {
          if (!previousIds.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return;
      }
      previousIds = visibleIds;
      queryClient.setQueryData<RecentActivityByAgent>(
        workspaceActivityQuery(workspaceId).queryKey,
        (current) => {
          if (!current) return current;
          let changed = false;
          const next: RecentActivityByAgent = {};
          for (const [agentId, entries] of Object.entries(current)) {
            if (visibleIds.has(agentId)) next[agentId] = entries;
            else changed = true;
          }
          return changed ? next : current;
        },
      );
    };
    prune(liveAgents.state);
    const subscription = liveAgents.subscribe((currentAgents) => prune(currentAgents));
    return () => subscription.unsubscribe();
  }, [liveAgents, workspaceId, queryClient]);

  const refreshAfterWrite = useRefreshAfterAgentWrite(refreshDirectory);

  return (
    <LiveAgentStoreContext value={liveAgents}>
      <StatusOnlyDisplaysContext value={statusOnlyStore}>
        <WorkspaceIdContext value={workspaceId}>
          <RefreshAgentDirectoryContext value={refreshAfterWrite}>
            <DisplayWatcherContext value={watched.watch}>
              <ReplyIntentStoreProvider value={replyIntents}>{children}</ReplyIntentStoreProvider>
            </DisplayWatcherContext>
          </RefreshAgentDirectoryContext>
        </WorkspaceIdContext>
      </StatusOnlyDisplaysContext>
    </LiveAgentStoreContext>
  );
}

/** Re-reads the owning Agent store after a write, preserving its snapshot if the read fails, and
 * marks the Members directory stale. */
export function useRefreshAgentDirectory() {
  const refresh = useContext(RefreshAgentDirectoryContext);
  if (!refresh) throw new Error("Agent directory refresh requires WorkspaceAgentsProvider");
  return refresh;
}

/** Whether an Agent is in the viewer's own roster, not an `isExtra` Agent. */
function inRoster(agent: { isExtra?: true }) {
  return !agent.isExtra;
}

/**
 * The live Agent list (with realtime status): the viewer's own roster.
 *
 * The Members directory / mention list roster: never includes an `isExtra` Agent. Those carry no
 * description and are read through `useLiveAgent(id)` (live status and Activity for the profile
 * panel), `useLiveWorkspaceAgents` (the chat list header) and `useVisibleLiveAgents`.
 */
export function useLiveAgents(): LiveAgent[] {
  const agents = useSelector(useContext(LiveAgentStoreContext), (state) => state);
  // One list per store value, not per call: consumers memoize on it, and a fresh array on every
  // render would invalidate all of them.
  return useMemo(() => agents.filter(inRoster), [agents]);
}

/**
 * Every live Agent the viewer may see, their own and the others' (`isExtra`): who the sidebar's
 * DMs are with and who may be replying. Any member may message another member's public Agent, and
 * the roster alone would leave that DM out of the list and its replies unannounced.
 */
export function useVisibleLiveAgents(): LiveAgent[] {
  return useSelector(useContext(LiveAgentStoreContext), (state) => state);
}

/** Who an Agent is, without what it is doing: a live Agent less its status and display. */
export type AgentDirectoryEntry = Omit<LiveAgent, "status" | "display">;

// Named fields only: a live Agent object also carries bookkeeping its type does not name (the
// display revision high-water mark), which changes with every display.
function directoryEntry(agent: LiveAgent): AgentDirectoryEntry {
  const { id, name, displayName, avatarUrl, mascot, visibility, isExtra } = agent;
  return {
    id,
    name,
    displayName,
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(mascot !== undefined ? { mascot } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(isExtra ? { isExtra } : {}),
  };
}

function sameEntries(a: readonly AgentDirectoryEntry[], b: readonly AgentDirectoryEntry[]) {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index]!;
      const keys = Object.keys(entry) as (keyof AgentDirectoryEntry)[];
      return (
        keys.length === Object.keys(other).length && keys.every((key) => entry[key] === other[key])
      );
    })
  );
}

/**
 * Every Agent the viewer may see, as `useVisibleLiveAgents` lists them, but only who each is: it
 * repaints when an Agent comes, goes or is renamed, never on a status heartbeat or a display
 * update, which arrive several times a second while Agents work (task #433). The sidebar's
 * directory reads this; a row that shows live state reads its own Agent (`useVisibleAgentDisplay`).
 */
export function useVisibleAgentDirectory(): AgentDirectoryEntry[] {
  return useSelector(useContext(LiveAgentStoreContext), (agents) => agents.map(directoryEntry), {
    compare: sameEntries,
  });
}

/**
 * The Agents of the Workspace the viewer may see — their own roster and the others' — picked by
 * `pick`, which must give the same Agents the same objects. Repaints only when the picked list
 * changes, so an Agent that `pick` leaves out costs nothing.
 */
export function useLiveWorkspaceAgents<T extends LiveAgent>(
  pick: (agents: readonly LiveAgent[]) => T[],
): T[] {
  return useSelector(useContext(LiveAgentStoreContext), pick, {
    compare: (a, b) => a.length === b.length && a.every((agent, index) => agent === b[index]),
  });
}

/** The current Workspace id from the app shell's providers, when one is selected. */
export function useCurrentWorkspaceId(): string | undefined {
  return useContext(WorkspaceIdContext);
}

export function useLiveAgent(agentId: string): LiveAgent | undefined {
  return useSelector(useContext(LiveAgentStoreContext), (agents) => agentById(agents, agentId));
}

export function useLiveAgentMascot(agentId: string): AgentMascot | undefined {
  return useSelector(useContext(LiveAgentStoreContext), (agents) => {
    const agent = agentById(agents, agentId);
    return agent && inRoster(agent) ? agent.mascot : undefined;
  });
}

export function useAgentRecentActivity(
  agentId: string,
  conversationId: string | undefined,
  enabled: boolean,
): ActivityEntry[] {
  const workspaceId = useContext(WorkspaceIdContext);
  const selectAgentRecent = useCallback(
    (data: RecentActivityByAgent) => data[agentId] ?? EMPTY_ACTIVITY,
    [agentId],
  );
  const selectConversationRecent = useCallback(
    (entries: ActivityEntry[]) =>
      activityInConversation(entries, conversationId).slice(0, RECENT_ACTIVITY_LIMIT),
    [conversationId],
  );
  const query = useQuery({
    ...workspaceActivityQuery(workspaceId),
    select: selectAgentRecent,
    enabled: enabled && !conversationId,
  });
  const scoped = useQuery({
    ...agentActivityFeedQuery(agentId),
    enabled: enabled && Boolean(conversationId),
    select: selectConversationRecent,
  });
  return (conversationId ? scoped.data : query.data) ?? EMPTY_ACTIVITY;
}

/** The profile panel's Activity tab feed, kept live by the shared subscription. */
export function useAgentActivityFeed(agentId: string) {
  return useQuery(agentActivityFeedQuery(agentId));
}

/** Reads an Agent's cached Activity feed when asked (a copy button's click) without observing it,
 * so the caller neither re-renders on each frame nor keeps the feed refetching. */
export function useReadAgentActivityFeed(agentId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.getQueryData(agentActivityFeedQuery(agentId).queryKey);
}

/** Starts loading an Agent's Activity feed without re-rendering the caller on each frame, so the
 * Activity tab is usually ready by the time it is selected; only when `enabled` (the viewer gets
 * the tab: the server answers no one else). */
export function usePrefetchAgentActivityFeed(agentId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (enabled) void queryClient.prefetchQuery(agentActivityFeedQuery(agentId));
  }, [queryClient, agentId, enabled]);
}
