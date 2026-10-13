import { AGENT_ACTIVITY_DETAIL_KIND, type AgentActivity } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection";

/** An activity envelope before the launch assigns its sequence metadata. */
export type ActivityDraft = Omit<AgentActivity, "launchId" | "clientSeq" | "observedAtMs">;

/** The launch fields publishing reads and advances. The launch object's identity is the fence:
 * only the Agent's current launch publishes, so a rebind updates `launchId` in place. */
export type PublishedActivityLaunch = {
  launchId: string;
  clientSeq: number;
  stopping: boolean;
};

/** One Agent that is still mid-turn when the runner hold is polled. */
export type BusyAgentReport = { agentId: string; detailKind: string; busySinceMs: number };

// While an Agent stays busy (working/thinking) through a long silent turn, the
// daemon re-sends the last busy Activity frame every 60s with isHeartbeat set
// so the server's 90s display lease (WORKING_LEASE_MS) never lapses; the 30s
// margin matches AGENT_STATUS_LEASE_MS's margin over AGENT_STATUS_REFRESH_MS.
// Kept here, not in daemon-connection.ts: the macOS lifecycle fixture replaces
// that module with a stub that only exports the connection class.
export const ACTIVITY_HEARTBEAT_MS = 60_000;

/** Detail kinds the busy heartbeat keeps warm: the Agent is working or thinking. */
const BUSY_ACTIVITY_DETAIL_KINDS = new Set<string>([
  AGENT_ACTIVITY_DETAIL_KIND.MODEL_REQUEST_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS,
  // Liveness-only fillers: busy, but content-free.
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED,
  // Visible, stored busy detail kinds.
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT,
  AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY,
  AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEWING_CHANGES,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_STALE,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_STALE,
  AGENT_ACTIVITY_DETAIL_KIND.STALLED_RECOVERY,
  AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
]);

/** Detail kinds that end a busy turn; the heartbeat stops as soon as one is observed. */
const TERMINAL_ACTIVITY_DETAIL_KINDS = new Set<string>([
  AGENT_ACTIVITY_DETAIL_KIND.IDLE,
  AGENT_ACTIVITY_DETAIL_KIND.STOPPED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
  AGENT_ACTIVITY_DETAIL_KIND.FRESHNESS_HOLD,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_CRASHED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED,
]);

/** Whether a detail kind means the Agent is working or thinking. */
export function isBusyActivityDetailKind(detailKind: string): boolean {
  return BUSY_ACTIVITY_DETAIL_KINDS.has(detailKind);
}

export type BusyActivity<L> = Readonly<{ launch: L; activity: ActivityDraft; at: number }>;

export type AgentActivityPublisherPorts<L extends PublishedActivityLaunch> = Readonly<{
  /** The Agent's current launch; Activity for any other launch is dropped. */
  currentLaunch(agentId: string): L | undefined;
  /** The current transport, read at each publish. Without an Activity sender, nothing is sent
   * and the launch's sequence does not advance. */
  readonly transport: Pick<DaemonConnectionClient, "sendAgentActivity">;
  /** Keeps the launch's counter past a process exit, so a wake reusing its launchId continues it. */
  recordClientSeq(agentId: string, clientSeq: number): void;
  /** Runs when a heartbeat is due. True when the turn turned out to be over and was reconciled
   * to idle, so no heartbeat goes out. */
  reconcileIdleTurn(agentId: string, launch: L): boolean;
}>;

/**
 * Publishes an Agent's best-effort Activity against its current launch: assigns the launch's
 * sequence metadata, mutes a stopping launch down to its final frames, and keeps the last busy
 * Activity warm with a heartbeat until a terminal kind or a stop ends it. The last busy Activity
 * is also the daemon's evidence that an Agent is mid-turn.
 */
export class AgentActivityPublisher<L extends PublishedActivityLaunch> {
  readonly #ports: AgentActivityPublisherPorts<L>;
  #enabled = false;
  readonly #heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #lastBusy = new Map<string, BusyActivity<L>>();

  constructor(ports: AgentActivityPublisherPorts<L>) {
    this.#ports = ports;
  }

  /** Activity flows once the runtime has started; until then every publish is dropped. */
  enable(): void {
    this.#enabled = true;
  }

  publish(agentId: string, launch: L, activity: ActivityDraft): void {
    if (!this.#enabled || this.#ports.currentLaunch(agentId) !== launch) return;
    if (launch.stopping) {
      this.forgetBusy(agentId);
      if (
        activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.STOPPED &&
        activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED &&
        activity.level !== "error" &&
        !activity.entries?.some((entry) => entry.kind !== "tool_start")
      )
        return;
    }
    this.#ports.transport.sendAgentActivity?.({
      ...activity,
      launchId: launch.launchId,
      clientSeq: ++launch.clientSeq,
      observedAtMs: Date.now(),
    });
    this.#ports.recordClientSeq(agentId, launch.clientSeq);
    if (TERMINAL_ACTIVITY_DETAIL_KINDS.has(activity.detailKind)) {
      this.forgetBusy(agentId);
    } else if (BUSY_ACTIVITY_DETAIL_KINDS.has(activity.detailKind)) {
      if (!activity.isHeartbeat) this.#lastBusy.set(agentId, { launch, activity, at: Date.now() });
      this.#scheduleHeartbeat(agentId, launch);
    }
  }

  /** Publishes against the Agent's current launch, if one exists. */
  publishCurrent(agentId: string, activity: ActivityDraft): void {
    const launch = this.#ports.currentLaunch(agentId);
    if (launch) this.publish(agentId, launch, activity);
  }

  /** The last busy Activity since the Agent's last terminal kind or stop, if any. */
  lastBusy(agentId: string): BusyActivity<L> | undefined {
    return this.#lastBusy.get(agentId);
  }

  busyAgents(): BusyAgentReport[] {
    return [...this.#lastBusy.entries()].map(([agentId, remembered]) => ({
      agentId,
      detailKind: remembered.activity.detailKind,
      busySinceMs: remembered.at,
    }));
  }

  /** Stops the Agent's heartbeat and erases its busy evidence. */
  forgetBusy(agentId: string): void {
    const timer = this.#heartbeatTimers.get(agentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#heartbeatTimers.delete(agentId);
    }
    this.#lastBusy.delete(agentId);
  }

  /** The runtime is stopping: nothing more is published and no heartbeat timer survives. */
  disable(): void {
    this.#enabled = false;
    for (const timer of this.#heartbeatTimers.values()) clearTimeout(timer);
    this.#heartbeatTimers.clear();
    this.#lastBusy.clear();
  }

  /** Re-sends the last busy Activity frame every ACTIVITY_HEARTBEAT_MS so a long silent
   * turn (a shell command or a quiet model call) never lets the display lease lapse. */
  #scheduleHeartbeat(agentId: string, launch: L): void {
    const existing = this.#heartbeatTimers.get(agentId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#heartbeatTimers.delete(agentId);
      const remembered = this.#lastBusy.get(agentId);
      if (!remembered || remembered.launch !== launch) return;
      if (this.#ports.reconcileIdleTurn(agentId, launch)) return;
      this.publish(agentId, launch, { ...remembered.activity, isHeartbeat: true, entries: [] });
    }, ACTIVITY_HEARTBEAT_MS);
    this.#heartbeatTimers.set(agentId, timer);
  }
}
