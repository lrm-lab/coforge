import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import {
  missedBySubscribe,
  type StreamPosition,
  type SubscribedRecovery,
} from "#src/features/realtime/subscription-gap";
import { ACTIVITY_PROBE_TIMEOUT_MS } from "./activity-probe-timeout";
import { isBusyTone } from "./agent-activity-presentation";
import type { AgentStatusEvent } from "./agent-status-channel";

export type StatusTrackedAgent = {
  id: string;
  status: AgentStatusView | UnknownAgentStatusView;
  computerId?: string | null;
  workspaceId?: string;
  display?: AgentDisplaySnapshot;
  displayRevisionHighWater?: number;
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
  if (!agents.some((agent) => agent.id === event.agentId && eventIsNewer(agent, event)))
    return agents;
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
  if (snapshot.statusOnly === true) return agents;
  let changed = false;
  const next = agents.map((agent) => {
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
    changed = true;
    return { ...agent, display: snapshot, displayRevisionHighWater: snapshot.revision };
  });
  return changed ? next : agents;
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

export async function statusSubscribeCatchUp(
  recovery: SubscribedRecovery,
  readPosition: StreamPosition | undefined,
  first: boolean,
): Promise<{ roster: boolean; directories: boolean }> {
  const roster = await missedBySubscribe(recovery, () => (first ? readPosition : undefined));
  return { roster, directories: roster && !first };
}

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
