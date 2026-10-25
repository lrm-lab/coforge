import type { AgentServiceTierObserved, RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { PublishedActivityLaunch } from "./agent-activity-publisher";

export type AgentUsageReportPorts = Readonly<{
  /** The Agent's current native session id, once the daemon has reported this launch's first
   * identity — a reading with none has nothing to attach to. */
  sessionId(agentId: string): string | undefined;
  /** The fields every daemon -> server report opens with. */
  envelope(): {
    protocolMajor: number;
    requestId: string;
    workspaceId: string;
    computerId: string;
  };
  daemonInstanceId(): string;
  /** The launch's shared clientSeq counter is recorded after every send on it. */
  recordClientSeq(agentId: string, clientSeq: number): void;
  sendContextUsage: DaemonConnectionClient["sendAgentContextUsage"];
  sendServiceTier: DaemonConnectionClient["sendAgentServiceTier"];
}>;

/**
 * The fire-and-forget per-launch readings the daemon reports to the cloud: context usage and the
 * observed service tier. Never blocks or fails the turn it observed; an unchanged reading is not
 * re-sent (the last reading is forgotten on launch end/dispose, so a new launch always sends its
 * first). Reuses Activity's own `clientSeq` counter on the launch — the same ordering fence
 * `AgentActivityPublisher.publish` advances — and records it so a wake reusing the launchId can
 * continue the counter.
 */
export class AgentUsageReport {
  readonly #ports: AgentUsageReportPorts;
  readonly #lastContextUsage = new Map<string, { usedTokens: number; windowTokens: number }>();
  readonly #lastServiceTier = new Map<string, AgentServiceTierObserved>();

  constructor(ports: AgentUsageReportPorts) {
    this.#ports = ports;
  }

  #report(
    agentId: string,
    launch: PublishedActivityLaunch,
    send: (clientSeq: number) => void,
  ): void {
    const clientSeq = ++launch.clientSeq;
    send(clientSeq);
    this.#ports.recordClientSeq(agentId, clientSeq);
  }

  /** A context-usage reading: skipped until the launch's native session id is known, and when
   * it repeats the last reading. */
  contextUsage(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    usedTokens: number,
    windowTokens: number,
  ): void {
    const sessionId = this.#ports.sessionId(agentId);
    if (!sessionId) return;
    const last = this.#lastContextUsage.get(agentId);
    if (last && last.usedTokens === usedTokens && last.windowTokens === windowTokens) return;
    this.#lastContextUsage.set(agentId, { usedTokens, windowTokens });
    this.#report(agentId, launch, (clientSeq) =>
      this.#ports.sendContextUsage?.({
        ...this.#ports.envelope(),
        agentId,
        provider,
        launchId: launch.launchId,
        sessionId,
        usedTokens,
        windowTokens,
        observedAtMs: Date.now(),
        daemonInstanceId: this.#ports.daemonInstanceId(),
        clientSeq,
      }),
    );
  }

  /** An observed service-tier reading: the same session-id gate and unchanged-reading skip. */
  serviceTier(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    observed: AgentServiceTierObserved,
  ): void {
    const sessionId = this.#ports.sessionId(agentId);
    if (!sessionId) return;
    if (this.#lastServiceTier.get(agentId) === observed) return;
    this.#lastServiceTier.set(agentId, observed);
    this.#report(agentId, launch, (clientSeq) =>
      this.#ports.sendServiceTier?.({
        ...this.#ports.envelope(),
        agentId,
        provider,
        launchId: launch.launchId,
        sessionId,
        requested: true,
        observed,
        observedAtMs: Date.now(),
        daemonInstanceId: this.#ports.daemonInstanceId(),
        clientSeq,
      }),
    );
  }

  /** Forgets an Agent's last readings (launch end/dispose). */
  forget(agentId: string): void {
    this.#lastContextUsage.delete(agentId);
    this.#lastServiceTier.delete(agentId);
  }

  /** Daemon shutdown. */
  clear(): void {
    this.#lastContextUsage.clear();
    this.#lastServiceTier.clear();
  }
}
