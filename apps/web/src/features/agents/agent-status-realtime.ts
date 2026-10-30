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
  type AgentStatusEvent,
} from "./agent-status-channel";
import {
  missedBySubscribe,
  type StreamPosition,
  type StreamPositions,
  type SubscribedRecovery,
} from "#src/features/realtime/subscription-gap";
import { AGENT_VISIBILITY } from "./agent-visibility";
import { ACTIVITY_PROBE_TIMEOUT_MS } from "./activity-probe-timeout";
import { isBusyTone } from "./agent-activity-presentation";

type StatusTrackedAgent = {
  id: string;
  status: AgentStatusView | UnknownAgentStatusView;
  computerId?: string | null;
  workspaceId?: string;
  display?: AgentDisplaySnapshot;
  displayRevisionHighWater?: number;
  /** Read by `useAgentStatuses` itself to derive which Agents in its own current
   * state need a per-Agent status subscription. */
  visibility?: string;
};
export type AgentStatusView = {
  value: "active" | "inactive";
  expiresAt: number | null;
  ordering?: {
    daemonInstanceId: string;
    clientSeq: number;
    observedAtMs: number;
  } | null;
};
type UnknownAgentStatusView = Omit<AgentStatusView, "value"> & {
  value: "unknown";
};

function eventIsNewer(agent: StatusTrackedAgent, event: AgentStatusEvent) {
  const ordering = agent.status.ordering;
  if (!ordering) return true;
  if (ordering.daemonInstanceId === event.daemonInstanceId) {
    if (event.clientSeq !== ordering.clientSeq) return event.clientSeq > ordering.clientSeq;
    return (
      event.observedAtMs === ordering.observedAtMs &&
      (event.status === agent.status.value ||
        (event.status === "active" && agent.status.value === "inactive"))
    );
  }
  return event.observedAtMs > ordering.observedAtMs;
}

export function applyAgentStatusEvent<T extends StatusTrackedAgent>(
  agents: T[],
  event: AgentStatusEvent,
): T[] {
  return agents.map((agent) =>
    agent.id === event.agentId && eventIsNewer(agent, event)
      ? {
          ...agent,
          status: {
            value: event.status,
            expiresAt:
              event.status === "active" && agent.status.value === "active"
                ? Math.max(agent.status.expiresAt ?? 0, event.expiresAt ?? 0)
                : event.expiresAt,
            ordering: {
              daemonInstanceId: event.daemonInstanceId,
              clientSeq: event.clientSeq,
              observedAtMs: event.observedAtMs,
            },
          },
        }
      : agent,
  );
}

export function applyAgentDisplaySnapshot<T extends StatusTrackedAgent>(
  agents: T[],
  snapshot: AgentDisplaySnapshot,
  workspaceId?: string,
): T[] {
  if (workspaceId && snapshot.workspaceId !== workspaceId) return agents;
  return agents.map((agent) => {
    if (
      agent.id !== snapshot.agentId ||
      (agent.workspaceId && agent.workspaceId !== snapshot.workspaceId) ||
      (agent.computerId && agent.computerId !== snapshot.computerId)
    )
      return agent;
    const highWater = Math.max(agent.displayRevisionHighWater ?? 0, agent.display?.revision ?? 0);
    if (snapshot.revision < highWater || (!agent.display && snapshot.revision === highWater))
      return agent;
    if (agent.display?.revision === snapshot.revision) return agent;
    return { ...agent, display: snapshot, displayRevisionHighWater: snapshot.revision };
  });
}

export function mergeAgentStatusSnapshot<T extends StatusTrackedAgent>(
  current: T[],
  snapshot: T[],
) {
  return snapshot.map((agent) => {
    const existing = current.find((value) => value.id === agent.id);
    if (!existing) return agent;
    const displaySnapshot = agent.display ?? existing.display;
    const withDisplay = displaySnapshot
      ? applyAgentDisplaySnapshot(
          [
            {
              ...agent,
              display: existing.display,
              displayRevisionHighWater: existing.displayRevisionHighWater,
            },
          ],
          displaySnapshot,
          agent.workspaceId,
        )[0]!
      : { ...agent, displayRevisionHighWater: existing.displayRevisionHighWater };
    const ordering = agent.status.ordering;
    if (!ordering) return { ...withDisplay, status: existing.status };
    if (agent.status.value === "unknown") return { ...withDisplay, status: existing.status };
    return applyAgentStatusEvent([{ ...withDisplay, status: existing.status }], {
      agentId: agent.id,
      status: agent.status.value,
      expiresAt: agent.status.expiresAt,
      ...ordering,
    })[0]!;
  });
}

/**
 * Appends any `extraAgents` entries not already present in `list` by id. `list` is a primary
 * Agent list (the viewer's `listAgents` roster); `extraAgents` are named Agents visible to the
 * viewer beyond it (another member's Agents), so the props paths keep them in the tracked list. A
 * `refresh()` result is not merged: it carries the extras it read, so it is authoritative for
 * them. If the primary list includes the same id, that entry wins.
 */
export function mergeExtraAgents<T extends StatusTrackedAgent>(list: T[], extraAgents: T[]): T[] {
  const ids = new Set(list.map((agent) => agent.id));
  return [...list, ...extraAgents.filter((extra) => !ids.has(extra.id))];
}

export function expireAgentStatuses<T extends StatusTrackedAgent>(agents: T[], now: number): T[] {
  return agents.map((agent) =>
    agent.status.value === "active" &&
    typeof agent.status.expiresAt === "number" &&
    agent.status.expiresAt <= now
      ? {
          ...agent,
          status: {
            ...agent.status,
            value: "inactive" as const,
            expiresAt: null,
          },
        }
      : agent,
  );
}

/**
 * The delay before `useAgentStatuses` next re-fetches the display snapshot,
 * given the current agents' display expiry deadlines. A `working`/`thinking`
 * display does not schedule its refresh at its own `expiresAt`: that
 * deadline is pushed out by `ACTIVITY_PROBE_TIMEOUT_MS + 1_000`, so the
 * refresh is purely a safety net behind the server sweep's own
 * `agent:display` push once its own probe times out. Every
 * other display kind keeps refreshing right at its own `expiresAt`. Returns
 * `undefined` when there is nothing to schedule.
 */
export function nextDisplayRefreshDelayMs<T extends StatusTrackedAgent>(
  agents: readonly T[],
  now: number,
): number | undefined {
  const deadline = Math.min(
    ...agents.flatMap((agent) => {
      const display = agent.display;
      if (!display || typeof display.expiresAt !== "number") return [];
      return [
        isBusyTone(display.activityKind)
          ? display.expiresAt + ACTIVITY_PROBE_TIMEOUT_MS + 1_000
          : display.expiresAt,
      ];
    }),
  );
  if (!Number.isFinite(deadline)) return undefined;
  return deadline <= now ? 1_000 : deadline - now + 10;
}

/**
 * What the Workspace status subscription reads again once `subscribed`: the roster if it may have
 * missed a publication (`missedBySubscribe`; on the first subscribe, judged by where the page's own
 * read stood at `readPosition`), and the directory projections too after a later subscribe that
 * did, since a missed directory publication can affect every open channel's mention queries.
 */
export async function statusSubscribeCatchUp(
  recovery: SubscribedRecovery,
  readPosition: StreamPosition | undefined,
  first: boolean,
): Promise<{ roster: boolean; directories: boolean }> {
  const roster = await missedBySubscribe(recovery, () => (first ? readPosition : undefined));
  return { roster, directories: roster && !first };
}

/**
 * Runs `run` when called, and when called while it runs, once more after: every call is answered
 * by a run that starts after it, however many calls arrive during one. A failed run is dropped.
 */
export function coalesced(run: () => Promise<unknown>): () => void {
  let running = false;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        again = false;
        await run().catch(() => {});
      } while (again);
      running = false;
    })();
  };
}

export function useAgentStatuses<T extends StatusTrackedAgent>({
  agents,
  workspaceId,
  refresh,
  extraAgents = [],
  onVisibilityChangedEvent,
  onDirectoryChangedEvent,
  readPositions,
}: {
  agents: T[];
  workspaceId?: string;
  refresh: () => Promise<T[]>;
  /** Named entries for Agents visible to the viewer beyond their own `agents` roster. Merged
   * (via `mergeExtraAgents`) into each new `agents` value; `refresh()` returns its own extras,
   * so its result is never merged with these. A live publication updates them in place. */
  extraAgents?: T[];
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
  const mounted = useRef(true);
  // The status channels subscribed so far, so each channel's first subscribe is told apart.
  const subscribedChannels = useRef(new Set<string>());
  const currentWorkspaceId = useRef(workspaceId);
  const visibleWorkspaceId = useRef(workspaceId);
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
        setVisibleAgents((current) => applyAgentDisplaySnapshot(current, snapshot, workspaceId));
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

  return { agents: visibleAgents, refresh: refreshSnapshot };
}
