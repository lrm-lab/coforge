import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createStore, useSelector, type Store } from "@tanstack/react-store";
import { parseAgentDisplaySnapshot, type AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import {
  useRealtimeSubscription,
  useRealtimeSubscriptions,
} from "#src/features/realtime/browser-realtime";
import { publicationData } from "#src/features/realtime/publication-data";
import {
  agentStatusChannel,
  agentStatusChannelForAgent,
  decodeAgentStatusEvent,
  isAgentDirectoryChangedEvent,
  isAgentVisibilityChangedEvent,
} from "./agent-status-channel";
import {
  decodeAgentControlEvent,
  isAgentControlEvent,
  recordAgentControlEvent,
} from "./agent-control-realtime";
import { missedBySubscribe, type StreamPositions } from "#src/features/realtime/subscription-gap";
import { AGENT_VISIBILITY } from "./agent-visibility";
import {
  dropStatusOnlyDisplay,
  mergeStatusOnlyDisplaySnapshot,
  type StatusOnlyDisplays,
} from "./agent-status-floor";
import {
  applyAgentDisplaySnapshot,
  applyAgentStatusEvent,
  coalesced,
  expireAgentStatuses,
  mergeAgentStatusSnapshot,
  mergeExtraAgents,
  nextDisplayDeadlineMs,
  nextDisplayRefreshDelayMs,
  nextStatusExpiryMs,
  statusSubscribeCatchUp,
  type AgentStatusView,
  type StatusTrackedAgent,
} from "./agent-status-reducers";

export {
  applyAgentDisplaySnapshot,
  applyAgentStatusEvent,
  coalesced,
  expireAgentStatuses,
  mergeAgentStatusSnapshot,
  mergeExtraAgents,
  nextDisplayRefreshDelayMs,
  statusSubscribeCatchUp,
  type AgentStatusView,
};

function selectPrivateAgentIds<T extends StatusTrackedAgent>(agents: readonly T[]): string[] {
  const ids: string[] = [];
  for (const agent of agents) {
    if (agent.visibility === AGENT_VISIBILITY.PRIVATE) ids.push(agent.id);
  }
  return ids;
}

function sameStringArray(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function useAgentStatuses<T extends StatusTrackedAgent>({
  agents,
  workspaceId,
  refresh,
  extraAgents = [],
  onVisibilityChangedEvent,
  onDirectoryChangedEvent,
  readPositions,
  statusOnlyAgentIds,
}: {
  agents: T[];
  workspaceId?: string;
  refresh: () => Promise<T[]>;
  /** Named entries for Agents visible to the viewer beyond their own `agents` roster. Merged
   * (via `mergeExtraAgents`) into each new `agents` value; `refresh()` returns its own extras,
   * so its result is never merged with these. A live publication updates them in place. */
  extraAgents?: T[];
  /** The ids of every live Agent in the Workspace (`statusAgentScopes`), whatever the viewer may
   * see: a `statusOnly` floor is kept only for one of them. Absent or empty accepts every floor —
   * the floor carries no Activity content, so an unread set never hides a status. */
  statusOnlyAgentIds?: ReadonlySet<string>;
  /** Called whenever this hook observes `agent:visibility_changed`, so the caller can
   * invalidate what else follows an Agent's visibility. */
  onVisibilityChangedEvent?: () => void;
  /** Called whenever an Agent directory event arrives. The caller can invalidate other
   * Workspace-scoped projections (for example channel mention directories). */
  onDirectoryChangedEvent?: () => void;
  /** Where `agents` and `extraAgents` were read in each status channel's stream, by channel: a
   * channel's first subscribe reads them again only if its stream moved past it. */
  readPositions?: StreamPositions;
}): {
  agentsStore: Store<T[]>;
  statusOnlyStore: Store<StatusOnlyDisplays>;
  privateAgentIds: string[];
  refresh: () => Promise<void>;
} {
  const [agentsStore] = useState(() =>
    createStore<T[]>(expireAgentStatuses(mergeExtraAgents(agents, extraAgents), Date.now())),
  );
  const [statusOnlyStore] = useState(() => createStore<StatusOnlyDisplays>(new Map()));
  const mounted = useRef(true);
  const subscribedChannels = useRef(new Set<string>());
  const currentWorkspaceId = useRef(workspaceId);
  const visibleWorkspaceId = useRef(workspaceId);
  const statusOnlyIds = useRef(statusOnlyAgentIds);
  useLayoutEffect(() => {
    statusOnlyIds.current = statusOnlyAgentIds;
    currentWorkspaceId.current = workspaceId;
  }, [statusOnlyAgentIds, workspaceId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (visibleWorkspaceId.current !== workspaceId) {
      visibleWorkspaceId.current = workspaceId;
      agentsStore.setState(() =>
        expireAgentStatuses(mergeExtraAgents(agents, extraAgents), Date.now()),
      );
      statusOnlyStore.setState(() => new Map());
      return;
    }
    agentsStore.setState((current) =>
      expireAgentStatuses(
        mergeAgentStatusSnapshot(current, mergeExtraAgents(agents, extraAgents)),
        Date.now(),
      ),
    );
  }, [agents, workspaceId, extraAgents, agentsStore, statusOnlyStore]);

  useEffect(() => {
    let scheduledAt: number | undefined;
    let timer: number | undefined;
    const sync = (current: readonly T[]) => {
      const nextAt = nextStatusExpiryMs(current);
      if (nextAt === scheduledAt) return;
      if (timer !== undefined) window.clearTimeout(timer);
      scheduledAt = nextAt;
      if (nextAt === undefined) {
        timer = undefined;
        return;
      }
      timer = window.setTimeout(
        () => {
          scheduledAt = undefined;
          timer = undefined;
          agentsStore.setState((list) => expireAgentStatuses(list, Date.now()));
        },
        Math.max(0, nextAt - Date.now()) + 10,
      );
    };
    sync(agentsStore.state);
    const subscription = agentsStore.subscribe((current) => sync(current));
    return () => {
      subscription.unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agentsStore]);

  useEffect(() => {
    const refreshWorkspaceId = workspaceId;
    let disposed = false;
    let scheduledDeadline: number | undefined;
    let timer: number | undefined;
    const requestRefresh = (delay: number) => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(runRefresh, delay);
    };
    const runRefresh = () => {
      timer = undefined;
      void refresh()
        .then((refreshed) => {
          if (disposed || !mounted.current || currentWorkspaceId.current !== refreshWorkspaceId)
            return;
          scheduledDeadline = undefined;
          agentsStore.setState((current) => mergeAgentStatusSnapshot(current, refreshed));
        })
        .catch(() => {
          if (!disposed && mounted.current && currentWorkspaceId.current === refreshWorkspaceId)
            requestRefresh(1_000);
        });
    };
    const sync = (current: readonly T[]) => {
      const deadline = nextDisplayDeadlineMs(current);
      if (deadline === scheduledDeadline) return;
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      scheduledDeadline = deadline;
      if (deadline === undefined) return;
      const delay = nextDisplayRefreshDelayMs(current, Date.now());
      if (delay !== undefined) requestRefresh(delay);
    };
    sync(agentsStore.state);
    const subscription = agentsStore.subscribe((current) => sync(current));
    return () => {
      disposed = true;
      subscription.unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agentsStore, refresh, workspaceId]);

  useEffect(() => {
    if (!statusOnlyAgentIds || statusOnlyAgentIds.size === 0) return;
    statusOnlyStore.setState((current) => {
      let next: Map<string, AgentDisplaySnapshot> | undefined;
      for (const agentId of current.keys())
        if (!statusOnlyAgentIds.has(agentId)) (next ??= new Map(current)).delete(agentId);
      return next ?? current;
    });
  }, [statusOnlyAgentIds, statusOnlyStore]);

  const refreshSnapshot = useCallback(async () => {
    const refreshed = await refresh();
    if (mounted.current && currentWorkspaceId.current === workspaceId)
      agentsStore.setState((current) =>
        expireAgentStatuses(mergeAgentStatusSnapshot(current, refreshed), Date.now()),
      );
  }, [agentsStore, refresh, workspaceId]);

  const catchUp = useMemo(() => coalesced(refreshSnapshot), [refreshSnapshot]);

  const handleStatusPublication = (data: unknown) => {
    try {
      const value = publicationData(data);
      if (isAgentVisibilityChangedEvent(value)) {
        catchUp();
        onVisibilityChangedEvent?.();
        onDirectoryChangedEvent?.();
      } else if (isAgentDirectoryChangedEvent(value)) {
        catchUp();
        onVisibilityChangedEvent?.();
        onDirectoryChangedEvent?.();
      } else if (Reflect.get(value as object, "type") === "agent:display") {
        const snapshot = parseAgentDisplaySnapshot(value);
        if (snapshot.statusOnly === true) {
          const ids = statusOnlyIds.current;
          if (
            (!workspaceId || snapshot.workspaceId === workspaceId) &&
            (!ids || ids.size === 0 || ids.has(snapshot.agentId))
          )
            statusOnlyStore.setState((current) =>
              mergeStatusOnlyDisplaySnapshot(current, snapshot),
            );
        } else {
          if (!workspaceId || snapshot.workspaceId === workspaceId)
            statusOnlyStore.setState((current) => dropStatusOnlyDisplay(current, snapshot.agentId));
          agentsStore.setState((current) =>
            applyAgentDisplaySnapshot(current, snapshot, workspaceId),
          );
        }
      } else if (isAgentControlEvent(value)) {
        recordAgentControlEvent(decodeAgentControlEvent(value));
      } else {
        const event = decodeAgentStatusEvent(value);
        agentsStore.setState((current) => applyAgentStatusEvent(current, event));
      }
    } catch {}
  };

  useRealtimeSubscription({
    channel: workspaceId ? agentStatusChannel(workspaceId) : undefined,
    onSubscribed: (recovery) => {
      if (!workspaceId) return;
      const channel = agentStatusChannel(workspaceId);
      const first = !subscribedChannels.current.has(channel);
      subscribedChannels.current.add(channel);
      const readPosition = readPositions?.[channel];
      void statusSubscribeCatchUp(recovery, readPosition, first)
        .then(({ roster, directories }) => {
          if (roster) catchUp();
          if (directories) {
            onVisibilityChangedEvent?.();
            onDirectoryChangedEvent?.();
          }
        })
        .catch(() => {});
    },
    onPublication: (publication) => handleStatusPublication(publication.data),
  });

  const privateAgentIds = useSelector(agentsStore, selectPrivateAgentIds, {
    compare: sameStringArray,
  });

  useRealtimeSubscriptions({
    channels: workspaceId
      ? privateAgentIds.map((agentId) => agentStatusChannelForAgent(workspaceId, agentId))
      : [],
    onSubscribed: (channel, recovery) => {
      void missedBySubscribe(recovery, () => readPositions?.[channel])
        .then((missed) => missed && catchUp())
        .catch(() => {});
    },
    onPublication: (_channel, publication) => handleStatusPublication(publication.data),
  });

  return { agentsStore, statusOnlyStore, privateAgentIds, refresh: refreshSnapshot };
}
