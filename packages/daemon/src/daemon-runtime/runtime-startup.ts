import { getLogger } from "@logtape/logtape";
import { mkdirSync } from "node:fs";
import type { RuntimeAuthAdapter, RuntimeAuthProvider } from "@lrm/coforge-anvil";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  diagnosticErrorCode,
  type AgentWorkspaceDeleteRequest,
  type AgentWorkspaceDeleteResult,
  type DaemonConnectRejectionReason,
  type RuntimeProvider,
  type UsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import type { PiChatFrame } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import type { DaemonCredentialStore } from "#src/credentials/credential-store";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { DaemonConnectionStoppedError } from "#src/connection/daemon-connection-stopped-error";
import { PiChatRelay } from "#src/pi-chat/relay";
import type { AgentControl } from "#src/agent-runtime/agent-control";
import type { AgentSessions } from "#src/agent-runtime/agent-session";
import type { OperatingSystemInfo } from "#src/platform/operating-system";
import type { DaemonConfig } from "./runtime";
import type { AgentWorkspaceQueries } from "./agent-workspace-queries";
import type { CodeAgentInventorySync } from "./code-agent-inventory-sync";
import type { RuntimeAuthReporter } from "./runtime-auth-reporter";
import type { RuntimeAuthController } from "./runtime-auth-controller";
import type { UpgradeResultReporter } from "./upgrade-result-reporter";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { ActivityLaunch } from "./activity-launch";
import type { ColdIdleSweep } from "./cold-idle-sweep";
import type { StalledRecoverySweep } from "./stalled-recovery-sweep";
import type { CatalogFreshnessSweep } from "./catalog-freshness-sweep";
import type { runtimeMachineStatus } from "./machine-status-reporter";
import { readyCapabilities } from "./ready-capabilities";
import { subscribeRuntimeAuth } from "./runtime-auth-subscription";
import { subscribeRuntimeReconnect } from "./runtime-reconnect";
import { subscribeProviderScans } from "./provider-scan-handlers";
import { subscribeWorkspaceQueries } from "./workspace-query-handlers";
import { subscribeLocalSessionQueries } from "./local-session-query-handlers";
import { LocalSessionCatalog } from "#src/local-session/local-session-catalog";
import {
  RuntimePublicationSubscriptions,
  type RuntimePublicationSubscriptionPorts,
} from "./runtime-publication-subscriptions";
import { unsubscribeAll } from "./runtime-transport-lifecycle";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** What `DaemonRuntime` supplies to one connection's open sequence: the collaborators it starts,
 * and the operations its listeners replay. */
export type RuntimeStartupPorts = {
  /** The Workspace's current transport, read at send time; it is replaced on a failed start. */
  transport: () => DaemonConnectionClient;
  replaceTransport: () => Promise<unknown>;
  credentials: Pick<DaemonCredentialStore, "load">;
  runtimeInstanceId: string;
  startedAtMs: number;
  computerVersion?: string;
  isStopping: () => boolean;
  /** Everything the connection publishes before ready is buffered and replayed by
   * `RuntimePublicationSubscriptions`; these are the operations it replays. */
  publications: Omit<
    RuntimePublicationSubscriptionPorts,
    "transport" | "workspaceId" | "computerId"
  >;
  agentControl: Pick<AgentControl, "replay">;
  agentSessions: Pick<AgentSessions, "replay">;
  readyRunningAgentIds(): string[];
  operatingSystem: Pick<OperatingSystemInfo, "read" | "current">;
  upgradeResults: Pick<UpgradeResultReporter, "start" | "report" | "stop">;
  runtimeAuth: Pick<RuntimeAuthReporter, "refresh" | "refreshProvider" | "usageScanned">;
  runtimeAuthFactory: (provider: RuntimeAuthProvider) => RuntimeAuthAdapter;
  codeAgentInventory: Pick<
    CodeAgentInventorySync,
    "reportRuntimes" | "refreshStaleCatalogs" | "refreshModels" | "readCommandCodeEfforts"
  >;
  scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse>;
  workspaceQueries: Pick<AgentWorkspaceQueries, "listSkills" | "listFiles" | "readFile" | "scan">;
  deleteWorkspace(
    request: AgentWorkspaceDeleteRequest,
  ): Promise<Pick<AgentWorkspaceDeleteResult, "status">>;
  sendPiChatFrame(frame: PiChatFrame): Promise<void>;
  lifecycle: {
    requestRestart?(requestId: string): Promise<void>;
    requestUpgrade?(requestId: string, expectedVersion?: string): Promise<void>;
    connectionRefused?(reason: DaemonConnectRejectionReason): void;
    recoveredRestartRequestIds?: string[];
    recoveredUpgradeRequestIds?: string[];
  };
  requestReminderSnapshot(agentId: string): Promise<void>;
  resyncAppConfigs(): void;
  activityPublisher: Pick<AgentActivityPublisher<ActivityLaunch>, "enable">;
  coldIdleSweep: Pick<ColdIdleSweep, "start">;
  stalledRecoverySweep: Pick<StalledRecoverySweep<ActivityLaunch>, "start">;
  catalogFreshnessSweep: Pick<CatalogFreshnessSweep, "start">;
  machineStatus: Pick<ReturnType<typeof runtimeMachineStatus>, "start">;
};

/**
 * One Workspace connection's open sequence: install the publication and auxiliary listeners,
 * start the transport, replay the control and session records, complete the ready handshake, then
 * release what the cloud held and kick off the optional work that must not gate the handshake.
 *
 * It also owns the state the sequence installs — the start promise and its abort signal, the
 * connection's subscriptions, the Pi chat relay, the runtime auth controller, and whether the
 * runtime counts as started — so `DaemonRuntime` only decides when to open a connection.
 */
export class RuntimeStartup {
  #promise: Promise<void> | undefined;
  /** Aborted by `abort`, so a start still waiting for the cloud never holds a stop up. */
  #abort: AbortController | undefined;
  #started = false;
  #subscriptions: Array<() => void> = [];
  #piChat?: PiChatRelay;
  #authControl: RuntimeAuthController | undefined;
  readonly #localSessions = new LocalSessionCatalog();

  constructor(private readonly ports: RuntimeStartupPorts) {}

  /** Whether the cloud handshake and recovery replay completed. */
  get started(): boolean {
    return this.#started;
  }

  /** The start still running, if any. */
  pending(): Promise<void> | undefined {
    return this.#promise;
  }

  start(connection: DaemonConfig): Promise<void> {
    if (this.#started) return Promise.resolve();
    if (this.#promise) return this.#promise;
    const abort = new AbortController();
    this.#abort = abort;
    this.#promise = this.#open(connection, abort.signal).finally(() => {
      this.#promise = undefined;
      this.#abort = undefined;
    });
    return this.#promise;
  }

  /** Closes the connection's local capabilities synchronously; the promise settles once the Pi
   * chat relay has closed. */
  close(): Promise<void> {
    this.#started = false;
    this.#authControl?.stop();
    this.#authControl = undefined;
    const piChat = this.#piChat;
    this.#piChat = undefined;
    const piChatClosed = piChat?.close();
    return piChatClosed ?? Promise.resolve();
  }

  /** Drops every listener the open sequence installed. */
  unsubscribeAll(): void {
    unsubscribeAll(this.#subscriptions);
  }

  /** Ends a start still waiting for the cloud, so a stop never waits on an unreachable server. */
  abort(): void {
    this.#abort?.abort(new DaemonConnectionStoppedError());
  }

  #subscribe(unsubscribe: (() => void) | undefined): void {
    if (unsubscribe) this.#subscriptions.push(unsubscribe);
  }

  async #open(connection: DaemonConfig, signal: AbortSignal): Promise<void> {
    const { ports } = this;
    mkdirSync(connection.workspaceRoot, { recursive: true });
    const token = await ports.credentials.load(connection.workspaceId, connection.computerId);
    if (!token) throw new Error("Workspace credential is missing");
    const publications = new RuntimePublicationSubscriptions({
      ...ports.publications,
      transport: ports.transport(),
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
    });
    try {
      const auth = subscribeRuntimeAuth(ports.transport(), {
        owner: {
          protocolMajor: 1,
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
        },
        workingDirectory: connection.workspaceRoot,
        createAdapter: ports.runtimeAuthFactory,
        refresh: () => ports.runtimeAuth.refresh(),
        refreshProvider: (provider) => ports.runtimeAuth.refreshProvider(provider),
      });
      this.#authControl = auth?.controller;
      this.#subscribe(auth?.unsubscribe);
      ports.upgradeResults.start();
      this.#subscribe(
        subscribeRuntimeReconnect(ports.transport(), {
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          refreshInventory: (transport) => {
            void ports.codeAgentInventory
              .reportRuntimes(transport)
              .then((report) => ports.codeAgentInventory.refreshStaleCatalogs(report, transport))
              .catch(() => {});
          },
          runningAgentIds: () => ports.readyRunningAgentIds(),
          requestReminderSnapshot: (agentId) => ports.requestReminderSnapshot(agentId),
          resyncAppConfigs: () => ports.resyncAppConfigs(),
          replayAgentControl: () => ports.agentControl.replay(),
          replayAgentSessions: () => ports.agentSessions.replay(),
          reportUpgradeResults: () => ports.upgradeResults.report(),
        }),
      );
      const transport = ports.transport();
      this.#piChat ??= new PiChatRelay(connection, (frame) => ports.sendPiChatFrame(frame));
      this.#subscribe(
        transport.onPiChatRequest?.(async (request) => {
          if (
            ports.isStopping() ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          await this.#piChat?.execute(request);
        }),
      );
      for (const unsubscribe of subscribeWorkspaceQueries(transport, {
        connection,
        observations: ports.workspaceQueries,
        deleteWorkspace: (request) => ports.deleteWorkspace(request),
        currentTransport: () => ports.transport(),
        isStopping: () => ports.isStopping(),
      }))
        this.#subscribe(unsubscribe);
      for (const unsubscribe of subscribeLocalSessionQueries(transport, {
        connection,
        catalog: this.#localSessions,
        currentTransport: () => ports.transport(),
        isStopping: () => ports.isStopping(),
      }))
        this.#subscribe(unsubscribe);
      for (const unsubscribe of subscribeProviderScans(transport, {
        connection,
        runtime: { scanUsage: (provider) => ports.scanUsage(provider) },
        currentTransport: () => ports.transport(),
        isStopping: () => ports.isStopping(),
        runtimeAuth: ports.runtimeAuth,
        inventory: ports.codeAgentInventory,
      }))
        this.#subscribe(unsubscribe);
      // Register publication listeners after the auxiliary query/scanning listeners, matching the
      // original start order; the server may recover persisted Agents immediately at ready.
      for (const unsubscribe of await publications.install()) this.#subscribe(unsubscribe);
      await transport.start(token, {
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        workerInstanceId: ports.runtimeInstanceId,
        startedAt: ports.startedAtMs,
        serverHttpUrl: connection.serverHttpUrl,
        requestRestart: ports.lifecycle.requestRestart,
        requestUpgrade: ports.lifecycle.requestUpgrade,
        signal,
      });
      await ports.agentControl.replay();
      await ports.agentSessions.replay();
      // Off the event loop, once: the OS version only changes with an upgrade.
      await ports.operatingSystem.read();
      await transport.ready(
        () => ({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: connection.workspaceId,
          // Legacy connection records have no computer identity; the server rejects this.
          computerId: connection.computerId ?? "",
          // Protocol field retained for compatibility with the existing ready handshake.
          workerInstanceId: ports.runtimeInstanceId,
          startedAt: ports.startedAtMs,
          runningAgentIds: ports.readyRunningAgentIds(),
          daemonVersion: COFORGE_DAEMON_VERSION,
          computerVersion: ports.computerVersion,
          ...ports.operatingSystem.current,
          recoveredRestartRequestIds: ports.lifecycle.recoveredRestartRequestIds ?? [],
          recoveredUpgradeRequestIds: ports.lifecycle.recoveredUpgradeRequestIds ?? [],
          capabilities: readyCapabilities(!!ports.publications.migration, !!this.#authControl),
        }),
        signal,
      );
      await ports.upgradeResults.report();
      await Promise.all(
        ports.readyRunningAgentIds().map((agentId) => ports.requestReminderSnapshot(agentId)),
      );
      ports.resyncAppConfigs();
      const { buffered, dropped } = publications.release();
      if (dropped > 0)
        logger.warn("Delivery notices held during start were dropped; the cloud resends them", {
          event: "daemon_runtime:notices_dropped",
          dropped,
        });
      this.#started = true;
      ports.activityPublisher.enable();
      ports.coldIdleSweep.start();
      ports.stalledRecoverySweep.start();
      ports.catalogFreshnessSweep.start();
      ports.machineStatus.start();
      // Kick off optional inventory before flushing buffered publications so immediate probes can
      // make progress while the first Agent inputs are delivered.
      const codeAgentReport = ports.codeAgentInventory.reportRuntimes(transport);
      await Promise.all(buffered.map((flush) => flush()));
      // Inventory is optional and may spawn several provider CLIs. Start accepting Agent
      // traffic as soon as the cloud handshake and recovery replay are complete; a slow probe
      // must never hold the first reply or a daemon restart hostage.
      void codeAgentReport
        .then((report) => ports.codeAgentInventory.refreshStaleCatalogs(report, transport))
        .catch(() => {});
    } catch (error) {
      this.#authControl?.stop();
      this.#authControl = undefined;
      this.unsubscribeAll();
      ports.upgradeResults.stop();
      this.#started = false;
      // A connection left up keeps reporting this Computer online for a Workspace that never
      // started, so a failed start takes its transport down too.
      const stopError = await ports.replaceTransport();
      if (stopError !== undefined)
        logger.warn("Stopping the connection of a failed start failed", {
          event: "daemon_runtime:failed_start_stop_failed",
          error_code: diagnosticErrorCode(stopError),
        });
      throw error;
    }
  }
}
