import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  nextDisplayRefreshDelayMs,
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
}) {
  const [visibleAgents, setVisibleAgents] = useState(() =>
    expireAgentStatuses(mergeExtraAgents(agents, extraAgents), Date.now()),
  );
  const [statusOnlyDisplays, setStatusOnlyDisplays] = useState<StatusOnlyDisplays>(() => new Map());
  const mounted = useRef(true);
  // The status channels subscribed so far, so each channel's first subscribe is told apart.
  const subscribedChannels = useRef(new Set<string>());
  const currentWorkspaceId = useRef(workspaceId);
  const visibleWorkspaceId = useRef(workspaceId);
  const statusOnlyIds = useRef(statusOnlyAgentIds);
  statusOnlyIds.current = statusOnlyAgentIds;
  currentWorkspaceId.current = workspaceId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (visibleWorkspaceId.current !== workspaceId) {
      visibleWorkspaceId.current = workspaceId;
      setVisibleAgents(expireAgentStatuses(mergeExtraAgents(agents, extraAgents), Date.now()));
      setStatusOnlyDisplays(new Map());
      return;
    }
    setVisibleAgents((current) =>
      expireAgentStatuses(
        mergeAgentStatusSnapshot(current, mergeExtraAgents(agents, extraAgents)),
        Date.now(),
      ),
    );
  }, [agents, workspaceId, extraAgents]);

  useEffect(() => {
    const statusExpiresAt = Math.min(
      ...visibleAgents.flatMap((agent) =>
        agent.status.value === "active" && agent.status.expiresAt ? [agent.status.expiresAt] : [],
      ),
    );
    if (!Number.isFinite(statusExpiresAt)) return;
    const timer = window.setTimeout(
      () => setVisibleAgents((current) => expireAgentStatuses(current, Date.now())),
      Math.max(0, statusExpiresAt - Date.now()) + 10,
    );
    return () => window.clearTimeout(timer);
  }, [visibleAgents]);

  useEffect(() => {
    const initialDelay = nextDisplayRefreshDelayMs(visibleAgents, Date.now());
    if (initialDelay === undefined) return;
    const refreshWorkspaceId = workspaceId;
    let disposed = false;
    let timer: number;
    const requestRefresh = (delay: number) => {
      timer = window.setTimeout(runRefresh, delay);
    };
    const runRefresh = () => {
      void refresh()
        .then((refreshed) => {
          if (disposed || !mounted.current || currentWorkspaceId.current !== refreshWorkspaceId)
            return;
          setVisibleAgents((current) => mergeAgentStatusSnapshot(current, refreshed));
        })
        .catch(() => {
          if (!disposed && mounted.current && currentWorkspaceId.current === refreshWorkspaceId)
            requestRefresh(1_000);
        });
    };
    requestRefresh(initialDelay);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refresh, visibleAgents, workspaceId]);

  // A floor is kept only for an Agent the status set still names: one that left the Workspace's
  // live Agents (deleted, or a failed read answering empty — treated as "not loaded" above)
  // drops its floor rather than answering for a name no surface should resolve.
  useEffect(() => {
    if (!statusOnlyAgentIds || statusOnlyAgentIds.size === 0) return;
    setStatusOnlyDisplays((current) => {
      let next: Map<string, AgentDisplaySnapshot> | undefined;
      for (const agentId of current.keys())
        if (!statusOnlyAgentIds.has(agentId)) (next ??= new Map(current)).delete(agentId);
      return next ?? current;
    });
  }, [statusOnlyAgentIds]);

  const refreshSnapshot = useCallback(async () => {
    const refreshed = await refresh();
    if (mounted.current && currentWorkspaceId.current === workspaceId)
      setVisibleAgents((current) =>
        expireAgentStatuses(mergeAgentStatusSnapshot(current, refreshed), Date.now()),
      );
  }, [refresh, workspaceId]);

  // One snapshot read per catch-up asked at once: several private channels subscribing together,
  // or the directory events a resubscribe replays.
  const catchUp = useMemo(() => coalesced(refreshSnapshot), [refreshSnapshot]);

  const handleStatusPublication = (data: unknown) => {
    try {
      const value = publicationData(data);
      if (isAgentVisibilityChangedEvent(value)) {
        // Refetch immediately: `mergeAgentStatusSnapshot` drops any Agent absent from the fresh
        // list (extras included), and its per-Agent channels follow from that same list.
        catchUp();
        onVisibilityChangedEvent?.();
        onDirectoryChangedEvent?.();
      } else if (isAgentDirectoryChangedEvent(value)) {
        // The event carries only an id and change kind. Re-read the caller's authorized roster
        // so create/delete/rename changes also update the status-dot store and private visibility
        // subscriptions without exposing directory data on the shared status channel.
        catchUp();
        // A created/deleted Agent may change what the viewer can see, so reuse the visibility
        // event's hook.
        onVisibilityChangedEvent?.();
        onDirectoryChangedEvent?.();
      } else if (Reflect.get(value as object, "type") === "agent:display") {
        const snapshot = parseAgentDisplaySnapshot(value);
        if (snapshot.statusOnly === true) {
          // The status floor a private Agent shares with every member: kept beside the tracked
          // Agents, never in their `display`, so it cannot stand in for or downgrade a full
          // snapshot — and only for an Agent the status set names.
          const ids = statusOnlyIds.current;
          if (
            (!workspaceId || snapshot.workspaceId === workspaceId) &&
            (!ids || ids.size === 0 || ids.has(snapshot.agentId))
          )
            setStatusOnlyDisplays((current) => mergeStatusOnlyDisplaySnapshot(current, snapshot));
        } else {
          if (!workspaceId || snapshot.workspaceId === workspaceId)
            setStatusOnlyDisplays((current) => dropStatusOnlyDisplay(current, snapshot.agentId));
          setVisibleAgents((current) => applyAgentDisplaySnapshot(current, snapshot, workspaceId));
        }
      } else if (isAgentControlEvent(value)) {
        // `agent.control.v1` feeds the control-phase store only; it never touches the status
        // or display state this hook owns.
        recordAgentControlEvent(decodeAgentControlEvent(value));
      } else {
        const event = decodeAgentStatusEvent(value);
        setVisibleAgents((current) => applyAgentStatusEvent(current, event));
      }
    } catch {}
  };

  // The status channels are subscribed without a token, the subscribe proxy checking each.
  useRealtimeSubscription({
    channel: workspaceId ? agentStatusChannel(workspaceId) : undefined,
    // Re-read the list once the channel is live if it may have missed a change: published after
    // the page's read but before the first subscribe (the stream moved past `readPositions`), or
    // while the connection was down beyond what the `agentstatus` namespace's short history
    // replays (`infra/centrifugo/config.yaml`).
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

  // One status subscription per visible private Agent, whose `agent:display` snapshots do not
  // arrive on the shared status channel, derived from this hook's own current `visibleAgents`
  // state — never an external, previous-render list, so a freshly-private Agent (e.g. right after
  // an `agent:visibility_changed` refresh above) is subscribed in the very render that learns
  // about it. Each catches up as the Workspace channel does, from the page's read position for it
  // if it has one.
  useRealtimeSubscriptions({
    channels: workspaceId
      ? visibleAgents
          .filter((agent) => agent.visibility === AGENT_VISIBILITY.PRIVATE)
          .map((agent) => agentStatusChannelForAgent(workspaceId, agent.id))
      : [],
    onSubscribed: (channel, recovery) => {
      void missedBySubscribe(recovery, () => readPositions?.[channel])
        .then((missed) => missed && catchUp())
        .catch(() => {});
    },
    onPublication: (_channel, publication) => handleStatusPublication(publication.data),
  });

  return { agents: visibleAgents, refresh: refreshSnapshot, statusOnlyDisplays };
}
