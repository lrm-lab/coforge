/**
 * What the Agent and Computer status caches tell app notifications about a presence change. The
 * caches know a transition only from the value they replaced, so they report it here and stay
 * ignorant of events, queues and Workspace flags; `AppNotificationPresence` is the implementation
 * that records them. An absent value counts as `inactive` / `offline`, as every status read does.
 */
export type AgentPresenceState = "active" | "inactive";
export type ComputerPresenceState = "online" | "offline";

export interface PresenceObserver {
  /** Whether anything could be notified at all; while false the caches take their ordinary path
   * and touch nothing else. */
  enabled(): boolean;
  /** An Agent's status field changed (`from !== to`). `idSeed` names the transition for good. */
  agentStatus(change: {
    workspaceId: string;
    agentId: string;
    from: AgentPresenceState;
    to: AgentPresenceState;
    observedAtMs: number;
    idSeed: string;
  }): void;
  /** A Computer came online or went offline (`from !== to`). */
  computerPresence(change: {
    workspaceId: string;
    computerId: string;
    from: ComputerPresenceState;
    to: ComputerPresenceState;
    observedAtMs: number;
    idSeed: string;
  }): void;
}

const noObserver: PresenceObserver = {
  enabled: () => false,
  agentStatus: () => {},
  computerPresence: () => {},
};

let current: PresenceObserver = noObserver;

/** The observer the status caches report to. Set once by the composition root
 * (`sweeps/background-sweeps.server`); until then, and in any process that never composes, it is a
 * no-op that is never `enabled()`, so the caches import nothing of the queue or the database. */
export function setPresenceObserver(observer: PresenceObserver): void {
  current = observer;
}

export function getPresenceObserver(): PresenceObserver {
  return current;
}
