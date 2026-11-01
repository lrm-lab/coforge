import { getLogger } from "@logtape/logtape";
import type { DaemonShutdownReason } from "@lrm/coforge-sdk/internal";
import { AgentProcessCleanupError } from "@lrm/coforge-anvil";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "#src/connection/shutdown-notice-timeout";
import type { AgentControl } from "#src/agent-runtime/agent-control";
import type { AgentSessions } from "#src/agent-runtime/agent-session";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { ActivityLaunch } from "./activity-launch";
import type { PhaseBookkeeping } from "./phase-bookkeeping";
import type { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import type { UpgradeResultReporter } from "./upgrade-result-reporter";
import type { AgentUsageReport } from "./agent-usage-report";
import type { AgentProxy } from "./runtime-launch-types";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import type { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import type { RuntimeStartup } from "./runtime-startup";
import { runtimeEnvelope } from "./runtime-envelope";
import { logAgentApiKeyRevokeFailed } from "./agent-failure-logs";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** What the closing flow needs from the runtime it closes. Every collaborator it stops is the
 * runtime's own, so it takes the same references the runtime reads. */
export type RuntimeStopPorts = {
  startup: Pick<RuntimeStartup, "close" | "unsubscribeAll" | "abort" | "pending">;
  coldIdleSweep: { stop(): void };
  stalledRecoverySweep: { stop(): void };
  catalogFreshnessSweep: { stop(): void };
  machineStatus: { stop(): void };
  activityPublisher: Pick<AgentActivityPublisher<ActivityLaunch>, "disable">;
  currentActivityLaunches: Map<string, ActivityLaunch>;
  phaseBookkeeping: Pick<PhaseBookkeeping, "disposeAll">;
  runtimeErrorHold: Pick<RuntimeErrorDeliveryHold, "disposeAll">;
  upgradeResults: Pick<UpgradeResultReporter, "stop">;
  usageReport: Pick<AgentUsageReport, "clear">;
  fastModeWarned: Set<string>;
  inputDrain: AgentInputDrain;
  agentLaunches: Map<string, Promise<unknown>>;
  agentProcessManager: AgentProcessManager;
  stoppingAgents: Set<string>;
  messageAttention: AgentMessageAttentionIndex;
  mentionDeliveries: MentionDeliveryTracker;
  reminders: Pick<ReminderScheduler, "stop" | "awaitIdle">;
  systemCleaner: Pick<SystemCleaner, "clear">;
  migrations: Pick<AgentMigrationRunner, "close"> | undefined;
  agentProxy: Pick<AgentProxy, "revoke"> | undefined;
  agentProxyTokens: Map<string, string>;
  agentContexts: Map<string, string>;
  agentControl: Pick<AgentControl, "dispose" | "stopped">;
  agentSessions: Pick<AgentSessions, "replay">;
  connection: { computerId: string };
  transport: () => DaemonConnectionClient;
  envelope(): ReturnType<typeof runtimeEnvelope>;
  runtimeInstanceId: string;
  agentApiKeys: Map<string, string>;
  revokeAgentApiKey(agentId: string, apiKey: string): Promise<void>;
  replaceTransport(): Promise<unknown>;
  consumedSeqs: Pick<AgentConsumedSeqStore, "close">;
  sendAgentStatus(agentId: string, status: "active" | "inactive"): void;
};

/**
 * One Workspace runtime's closing flow: close every local capability synchronously, bring each
 * Agent process down, settle what was already running (reminders, migrations, the Pi chat relay),
 * report the Agents inactive, revoke their keys and send the shutdown notice, then take the
 * transport down. `DaemonRuntime` owns the runner hold and the `stopping` flag it flips around
 * this, and delegates the rest.
 */
export class RuntimeStop {
  #promise: Promise<void> | undefined;
  /** The migration runs `run` aborted; the settle wait below bounds them. */
  #migrationsClosed: Promise<void> | undefined;

  constructor(private readonly ports: RuntimeStopPorts) {}

  /** The stop in progress, if any. */
  pending(): Promise<void> | undefined {
    return this.#promise;
  }

  run(shutdownReason: DaemonShutdownReason): Promise<void> {
    if (this.#promise) return this.#promise;
    const { ports } = this;
    // Close every local capability synchronously before any shutdown await.
    const piChatClosed = ports.startup.close();
    ports.coldIdleSweep.stop();
    ports.stalledRecoverySweep.stop();
    ports.catalogFreshnessSweep.stop();
    ports.machineStatus.stop();
    ports.activityPublisher.disable();
    for (const [agentId, launch] of ports.currentActivityLaunches) {
      launch.startup?.dispose();
      launch.stalled?.dispose(agentId);
    }
    ports.phaseBookkeeping.disposeAll();
    ports.runtimeErrorHold.disposeAll();
    ports.upgradeResults.stop();
    ports.usageReport.clear();
    ports.fastModeWarned.clear();
    for (const agentId of new Set([
      ...[...ports.inputDrain.entries()].map(([agentId]) => agentId),
      ...ports.agentLaunches.keys(),
      ...ports.agentProcessManager.activeAgentIds(),
    ])) {
      ports.stoppingAgents.add(agentId);
      ports.inputDrain.close(agentId, new Error("daemon runtime is stopping"));
      ports.messageAttention.clearAgent(agentId, { cancelNotices: true });
      void ports.mentionDeliveries.cancelAgent(agentId);
      ports.agentProcessManager.session(agentId)?.cancelPendingNotices?.();
    }
    ports.startup.unsubscribeAll();
    // A start still waiting for its first cloud connection would otherwise hold this stop up for
    // as long as the cloud stays unreachable.
    ports.startup.abort();
    ports.reminders.stop();
    ports.systemCleaner.clear();
    // Each attempt is leased again on the next ready, and its run picks up from the server's state.
    this.#migrationsClosed = ports.migrations?.close();
    for (const token of ports.agentProxyTokens.values()) ports.agentProxy?.revoke(token);
    ports.agentProxyTokens.clear();
    ports.agentContexts.clear();
    this.#promise = this.#stop(shutdownReason, piChatClosed).finally(() => {
      this.#promise = undefined;
    });
    return this.#promise;
  }

  /**
   * Waits for the reminder work that was already running when `run` closed the scheduler: a fire
   * request awaiting the cloud, a wake, and the receipt writes they lead to. A receipt is the
   * re-fire fence, so a write that has begun must land before the state directory is released
   * (a caller that removes it right after `run` would otherwise see the write recreate it).
   * The scheduler starts nothing new once stopped; this only lets the started work finish.
   *
   * The bound is `DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS`, the one teardown bound that fits the whole
   * stop in the service manager's grace period (launchd: 5 s). This wait runs alongside the
   * notice, so it never extends the stop past what the notice's own bound allows. The fire
   * request's own timeout cannot be the bound:
   * centrifuge-js gives every RPC its default 5 s (`timeout`), which nothing here changes, and that
   * alone would use the whole grace period. A stop that gives up leaves the receipt written before
   * the fire in place, so the next daemon repeats the same request.
   */
  async #settleReminders(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS);
    });
    try {
      const settled = await Promise.race([
        this.ports.reminders.awaitIdle().then(() => "settled" as const),
        timedOut,
      ]);
      if (settled === "timed_out")
        logger.info("Stop gave up waiting for reminder work that was still running", {
          event: "daemon_runtime:reminder_settle_timed_out",
          outcome: "unknown",
          duration_ms: DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
        });
    } finally {
      // A pending timer would keep the process alive for the rest of the bound.
      clearTimeout(timer);
    }
  }

  /**
   * Waits, on the same bound as `#settleReminders`, for the migration runs `run` aborted: a
   * placement's rename or an attempt's removal under the state directory must not outlive it. A
   * run that is still going when the bound passes is picked up from the server's state next time.
   */
  async #settleMigrations(): Promise<void> {
    const closed = this.#migrationsClosed;
    if (!closed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #stop(shutdownReason: DaemonShutdownReason, piChatClosed: Promise<void>): Promise<void> {
    const { ports } = this;
    // No retry timer may outlive this daemon instance: a launch that was mid-cooldown left a
    // "starting" record behind, which the next instance repairs and recovers (`recover()`).
    ports.agentControl.dispose();
    const activeAgentIds = ports.agentProcessManager.activeAgentIds();
    const sessions = activeAgentIds.map((id) => ({
      id,
      session: ports.agentProcessManager.session(id),
      launchId: ports.currentActivityLaunches.get(id)?.launchId,
    }));
    let shutdownError: unknown;
    // Start cleanup before awaiting any launch or input that cleanup itself must release.
    try {
      await ports.agentProcessManager.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    const start = ports.startup.pending();
    if (start) await Promise.allSettled([start]);
    await Promise.allSettled(ports.agentLaunches.values());
    await Promise.allSettled(ports.inputDrain.drains());
    try {
      // Reconcile sessions whose creation finished during shutdown, including failed cleanup.
      for (const agentId of ports.stoppingAgents)
        if (ports.agentProcessManager.isStopping(agentId)) throw new AgentProcessCleanupError();
      await ports.agentProcessManager.shutdown();
      ports.stoppingAgents.clear();
      for (const { id, session, launchId } of sessions) {
        if (launchId)
          await ports.agentControl.stopped(id, launchId, await session?.readSessionIdentity?.());
        await ports.agentSessions.replay(id);
      }
    } catch (error) {
      shutdownError ??= error;
    }
    for (const agentId of activeAgentIds) ports.sendAgentStatus(agentId, "inactive");
    ports.currentActivityLaunches.clear();
    // Every Agent process is down now. Each key they were using gets its one revoke request,
    // best-effort: a failure is logged, never fails teardown, and is not retried. The shutdown
    // notice goes out alongside, never ahead of them: its own bound must not push the revokes
    // past the service manager's grace period. The transport bounds it and never throws. Reminder
    // work already running settles alongside too, on the same bound, before the transport closes.
    await Promise.all([
      this.#settleReminders(),
      piChatClosed,
      this.#settleMigrations(),
      ports.connection.computerId
        ? ports.transport().sendShutdownNotice?.({
            ...ports.envelope(),
            workerInstanceId: ports.runtimeInstanceId,
            reason: shutdownReason,
          })
        : undefined,
      ...[...ports.agentApiKeys].map(([agentId, agentApiKey]) =>
        ports.revokeAgentApiKey(agentId, agentApiKey).catch((error) => {
          logAgentApiKeyRevokeFailed(agentId, error);
        }),
      ),
    ]);
    const transportError = await ports.replaceTransport();
    shutdownError ??= transportError;
    // Every write already committed; closing releases the WAL and the file handles.
    ports.consumedSeqs.close();
    if (shutdownError !== undefined) throw shutdownError;
  }
}
