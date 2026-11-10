import { createRuntimeAuthAdapter } from "#src/code-agent/registry";
import { AgentStopRegistry } from "./agent-stop-registry";
import type { RuntimeAuthAdapter, RuntimeAuthProvider } from "@lrm/coforge-anvil";
import {
  type AgentRuntimeConfig,
  type CodeAgentProvider,
  type UsageSnapshot,
} from "@lrm/coforge-anvil";
import { OperatingSystemInfo } from "#src/platform/operating-system";
import { assembleInputDrain } from "./assemble-input-drain";
import { attachFreshSessionMemoryPort } from "./session-memory-hooks";
import { rebindAgent } from "./agent-rebind";
import { AgentLaunchCustody } from "./agent-launch-custody";
import { AgentContexts } from "./agent-contexts";
import { assemblePhaseBookkeeping } from "./phase-bookkeeping-wiring";
import { type RuntimeEventObservationPorts } from "./runtime-event-observation-ports";
import {
  launchEventObserver,
  handleAgentStart,
  handleAgentStop,
  controlIntentPorts,
  handleAgentTurnInterrupt,
  handleAgentWorkspaceReset,
  scanUsage,
  type AgentControlIntentPorts,
} from "./runtime-agent-flows";
import type { AgentProxy, LaunchRequest, SessionMode } from "./runtime-launch-types";
import {
  type AgentProcessManager,
  type CodeAgentProviderFactory,
  type AgentRuntime,
} from "#src/agent-runtime/agent-process-manager";
import { createAgentProcessManager } from "./agent-process-manager-factory";
import { activityDraft } from "./activity-draft";
import type { AgentRecoveryContext } from "./runtime-launch-intent";
import { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import { createAgentDesktopHolds } from "#src/agent-runtime/agent-desktop";
import type { DaemonConfig } from "./runtime-connection-config";
export type { DaemonConfig, WorkspaceConfig } from "./runtime-connection-config";
import type { DaemonCredentialStore } from "#src/credentials/credential-store";
import type {
  DaemonConnectionClient,
  DaemonConnectionClientFactory,
} from "#src/connection/daemon-connection-client";
import { DaemonConnectionStoppedError } from "#src/connection/daemon-connection-stopped-error";
import {
  disposeLaunchObservations,
  readyRunningAgentIds,
  revokeLocalLaunch,
} from "#src/daemon-runtime/agent-launch-revocation";
import {
  ComputerUpdateNotice,
  observeLatestComputerVersion,
} from "#src/daemon-runtime/computer-update-notice";
import {
  localComputerUpdateNotice,
  localVersionResponse,
} from "#src/daemon-runtime/runtime-local-queries";
import {
  type RunnerHoldReason,
  type AgentActivity,
  type AgentMessageResponse,
  type AgentStartIntent,
  type AgentSessionReport,
  type AgentStopIntent,
  type AgentConfigSync,
  type AgentTurnInterruptIntent,
  type SessionIdentity,
  type AgentActivityProbe,
  type AgentInboxPurge,
  type AgentWorkspaceResetRequest,
  type AgentMessageDelivery,
  type InboxResponse,
  type LocalAgentMessageRequest,
  type LocalInboxRequest,
  type RuntimeProvider,
  type UsageScanResponse,
  type LocalReminderRequest,
  type ReminderJob,
  type TaskCommand,
  type TaskResult,
  type AgentWorkspaceDeleteRequest,
  type AgentWorkspaceDeleteResult,
} from "@lrm/coforge-sdk/internal";
import type { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentWorkspaceQueries } from "./agent-workspace-queries";
import { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { assembleRuntimeRelease } from "./runtime-release-assembly";
import { assembleAgentRequests } from "./agent-request-forwarder";
import { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import { AgentStopCoordinator } from "./agent-stop-coordinator";
import { AgentLaunchCoordinator } from "./agent-launch-coordinator";
import { startAgent } from "./agent-start-coordinator";
import { deleteWorkspace } from "./runtime-lifecycle-operations";
import { startupLifecycle } from "./runtime-upgrade-lifecycle";
import { assertOwnIntent } from "./runtime-intent-validation";
import { currentObservedUsage } from "./runtime-usage-observation";
import { failCollectorRunningSlots } from "./runtime-collector-failure";
import { runtimeEnvelope } from "./runtime-envelope";
import { replaceTransport } from "./runtime-transport-lifecycle";
import { holdRunners, releaseRunners } from "./runtime-runner-hold";
import { agentTask, acceptReminderDue, mintAppItem, reminder } from "./runtime-agent-api-reminders";
import {
  drainAppInboxNotices,
  inbox,
  requestAppConfigSnapshot,
  requestReminderSnapshot,
  resyncAppConfigs,
} from "./runtime-app-inbox-sync";
import { handleAgentMessage } from "./runtime-message-delivery";
import {
  flushHeldDeliveries,
  interruptIfBusy,
  isWorking,
  narrateUnavailable,
  reconcileIdleTurn,
  releaseSurvivingHolds,
  releaseTurnEndHolds,
  showQuietTurn,
} from "./runtime-turn-management";
import { abandonLaunch, scheduleStartupFailure } from "./agent-startup-failure";
import { revokeAgentApiKey } from "./agent-api-key-revoke";
import { ColdIdleSweep } from "./cold-idle-sweep";
import { assembleAgentConfigApply } from "./agent-config-apply-assembly";
import { stalledRecoverySweep } from "./stalled-recovery-sweep";
import { CatalogFreshnessSweep } from "./catalog-freshness-sweep";
import { rememberUsage } from "./usage-memory";
import { runtimeMachineStatus } from "./machine-status-reporter";
import { agentActivityDrafts } from "./agent-activity-drafts";
import { sendAgentStatus, type AgentStatusReportPorts } from "./agent-status-report";
import { agentIdForContext, contextFor } from "./agent-context";
import { cleanupUnconfirmed, buildLaunchFailureActivity } from "./launch-failure-activity";
import { RuntimeRelease, wakeRequest, type WakeRestart } from "./runtime-release";
import { beginWakeLaunch } from "./wake-launch";
import { AgentFeatureSync } from "./agent-feature-sync";
import { forgetAgent } from "./forget-agent";
import { WakeRecycle } from "./wake-recycle";
import { AgentMessageOperations } from "./agent-message-operations";
import { AgentRequestForwarder } from "./agent-request-forwarder";
import { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import {
  applyContextViewGate,
  reportContextViewAvailability,
  reportServerFeatureAvailability,
  resolveContextViewProviderSource,
} from "./context-view-runtime-wiring";
import { AgentDeliveryGate } from "./agent-delivery-gate";
import { ReplyIntentPublisher } from "./reply-intent-publisher";
import {
  AgentActivityPublisher,
  type ActivityDraft,
  type BusyAgentReport,
} from "./agent-activity-publisher";
import { assembleRuntimeErrorDeliveryHold } from "./assemble-runtime-error-hold";
import { consumeResetCredit } from "./reset-credit-consume";
import type { ActivityLaunch } from "./activity-launch";
import { AgentOfflineResidency } from "./agent-offline-residency";
import { AgentExitedDelivery } from "./agent-exited-delivery";
import { assembleUsageReport } from "./agent-usage-report-wiring";
import { MentionDeliveryTracker, type RunningMentionIdentity } from "./mention-delivery-tracker";
import { ReportedSessions } from "./reported-sessions";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type { MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import type { SystemCleaner, SystemCleanerOptions } from "#src/system-cleaner/system-cleaner";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import { AgentPreflightError } from "./agent-preflight-error";
import { shutdownReasonForHold, type RunnerHold } from "./shutdown-reason";
import { CodeAgentInventorySync, type CodeAgentDiscovery } from "./code-agent-inventory-sync";
import { RuntimeAuthReporter } from "./runtime-auth-reporter";
import { RuntimeStartup } from "./runtime-startup";
import { RuntimeStop } from "./runtime-stop";
import { composeMessages } from "./message-composition";
import { assembleExitedDelivery } from "./assemble-exited-delivery";
import { composeRuntimeServices, migrationRoute } from "./runtime-services-composition";
import { AgentOperations } from "./agent-operations";
import { composeAgentControl } from "./agent-control-composition";
import { UpgradeResultReporter } from "./upgrade-result-reporter";
import type { DaemonRuntimeLifecycle } from "./runtime-lifecycle";
import type { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import type { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import { logComputerUpdateNoticeFailure } from "./agent-failure-logs";
import { acceptAppRegistrationNotice } from "#src/agent-app-inbox/app-registration-notice";
import type { AgentVersionResponse } from "@lrm/coforge-sdk/agent";

/** Per-provider reading deadline supplied by a runtime usage scan. */
export { USAGE_SCAN_READ_TIMEOUT_MS } from "./runtime-agent-flows";

const NOT_RUNNING = "daemon runtime is not running";

/** A daemon-owned resident runtime for one supervised Workspace. */
export class DaemonRuntime {
  readonly #connection: DaemonConfig;
  readonly #drafts: ReturnType<typeof agentActivityDrafts>;
  readonly #createProvider: CodeAgentProviderFactory;
  readonly #agentProcessManager: AgentProcessManager;
  readonly #credentials: DaemonCredentialStore;
  readonly #transportFactory: DaemonConnectionClientFactory;
  readonly #computerUpdateNotice: ComputerUpdateNotice;
  #transport: DaemonConnectionClient;
  #stopPromise: Promise<void> | undefined;
  #stopping = false;
  readonly #agentControl: AgentControl;
  readonly #agentSessions: AgentSessions;
  readonly #messageAttention: AgentMessageAttentionIndex;
  readonly #messageOperations: AgentMessageOperations;
  /** The Agent requests the daemon only authorizes and forwards over Agent HTTPS. */
  readonly agentRequests: AgentRequestForwarder;
  readonly #mentionDeliveries: MentionDeliveryTracker;
  /** Last cloud-reported launch/session identity per Agent. */
  readonly #reported = new ReportedSessions();
  /** Durable context-view indexing and availability reporting for this Workspace runtime. */
  readonly #contextViewService: AgentContextViewService;
  /** Busy-gated delivery holding for providers with no safe busy path. */
  readonly #deliveryGate = new AgentDeliveryGate();
  /** Launch failures of message-triggered wakes, per Agent. */
  readonly #wakeLaunchFailures = new LaunchFailureBackoff();
  // Before the ports objects that reference them.
  #isWorking = (agentId: string): boolean => isWorking(this.#turnPorts(), agentId);
  #sendAgentStatus = (agentId: string, status: "active" | "inactive"): void =>
    sendAgentStatus(this.#statusReportPorts, agentId, status);
  readonly #exitedDelivery: AgentExitedDelivery = assembleExitedDelivery({
    deliveryGate: this.#deliveryGate,
    wakeLaunchFailures: this.#wakeLaunchFailures,
    sendAgentStatus: this.#sendAgentStatus,
    messageAttention: () => this.#messageAttention,
    launchCustody: () => this.#launchCustody,
    agentProcessManager: () => this.#agentProcessManager,
    agentControl: () => this.#agentControl,
    offlineResidency: () => this.#offlineResidency,
    inputDrain: () => this.#inputDrain,
    mentionDeliveries: () => this.#mentionDeliveries,
    transport: () => this.#transport,
    computerId: () => this.#connection.computerId,
    wakeAgent: (agentId, restart) => this.#wakeAgent(agentId, restart),
    handleAgentMessage: (message) => this.handleAgentMessage(message),
  });
  /** Agents whose in-flight launch is a message wake, which presents what waits as one notice. */
  readonly #wakeLaunches = new Set<string>();
  readonly #sync = new AgentFeatureSync({
    live: (agentId) => this.#runtimeRelease.canRestartForFreshConfig(agentId),
    keep: (m) => this.#exitedDelivery.keepForNextLaunch(m.agentId, m),
    restart: (agentId) => this.#runtimeRelease.restartForFreshConfig(agentId),
    observe: (agentId, features) => applyContextViewGate(this, agentId, features?.agentContextView),
    reportAvailability: (agentId) => reportServerFeatureAvailability(this, agentId),
  });
  readonly #runtimeRelease: RuntimeRelease<ActivityLaunch> = assembleRuntimeRelease({
    launches: () => this.#currentActivityLaunches,
    processManager: () => this.#agentProcessManager,
    activityPublisher: () => this.#activityPublisher,
    activity: (agentId, kind, level, detail, extra) =>
      this.#activity(agentId, kind, level, detail, extra),
    inputDrain: () => this.#inputDrain,
    working: this.#isWorking,
    deliveryGate: () => this.#deliveryGate,
    agentLaunches: () => this.#agentLaunches,
    stopState: () => this.#stopState,
    runnerHold: () => this.#runnerHold,
    migrations: () => this.#migrations,
    runningMentionIdentity: (agentId) => this.#runningMentionIdentity(agentId),
    noticeActionClocks: () => this.#messageAttention.noticeActionClocks,
    releaseSurvivingHolds: (agentId) => this.#releaseSurvivingHolds(agentId),
    wakeAgent: (agentId, restart) => this.#wakeAgent(agentId, restart),
    mentionDeliveries: () => this.#mentionDeliveries,
  });
  /** Stops cold, idle, large-context runtimes; the next launch decides resume or fresh session. */
  readonly #coldIdleSweep = new ColdIdleSweep({
    agentIds: () => this.#agentProcessManager.runningAgentIds(),
    agent: (agentId) => this.#runtimeRelease.coldIdleAgent(agentId),
    provider: (provider) => this.#createProvider(provider),
    stop: (stop) => this.#runtimeRelease.stopColdIdle(stop),
  });
  /** Applies a pushed Agent configuration when the Agent is next idle. */
  readonly #configApply = assembleAgentConfigApply({
    runtimeRelease: () => this.#runtimeRelease,
    processManager: () => this.#agentProcessManager,
    agentLaunches: () => this.#agentLaunches,
    activityLaunches: () => this.#currentActivityLaunches,
  });
  readonly #stalledRecoverySweep = stalledRecoverySweep({
    agentIds: () => this.#agentProcessManager.runningAgentIds(),
    hasQueuedDeliveries: (agentId) => this.#deliveryGate.hasQueued(agentId),
    runnerHold: () => this.#runnerHold !== undefined,
    isStopping: (agentId) => this.#stopState.stopping(agentId),
    release: this.#runtimeRelease,
  });
  /** Re-reads model catalogs whose on-disk key changed: an update, a sign-in or a sign-out. */
  readonly #catalogFreshnessSweep = new CatalogFreshnessSweep({
    transport: () => (this.#startup.started && !this.#stopping ? this.#transport : undefined),
    recheck: (transport) => this.#codeAgentInventory.recheckCatalogs(transport),
  });
  /** The OS version the ready report carries; read once, off the ready path. */
  readonly #operatingSystem = new OperatingSystemInfo();
  /** Reports this machine's disk and memory while the connection is up. */
  readonly #machineStatus = runtimeMachineStatus({
    connection: () => this.#connection,
    dataDirectory: () => this.stateDirectory,
    transport: () => (this.#startup.started && !this.#stopping ? this.#transport : undefined),
  });
  readonly #wakeRecycle = new WakeRecycle({
    provider: (provider) => this.#createProvider(provider),
    inputQueue: (agentId) => this.#inputDrain.get(agentId),
    hasQueuedDeliveries: (agentId) => this.#deliveryGate.hasQueued(agentId),
  });
  readonly #runtimeErrorHold = assembleRuntimeErrorDeliveryHold({
    stateDirectory: () => this.stateDirectory,
    deliveryGate: this.#deliveryGate,
    flush: (agentId, held) => flushHeldDeliveries(this.#turnPorts(), agentId, held),
    backoffEnded: (agentId) => this.#exitedDelivery.backoffEnded(agentId),
  });
  readonly #reminders: ReminderScheduler;
  readonly #appConfigs: AgentAppConfigSync;
  /** This Computer's Agent migration runs; absent when the transport cannot reach the route. */
  readonly #migrations: AgentMigrationRunner | undefined;
  readonly #inboxCoordinator: AgentInboxCoordinator;
  readonly #stopCoordinator: AgentStopCoordinator;
  readonly #launchCoordinator: AgentLaunchCoordinator;
  /** Per-Agent MEMORY.md and disk hints. Inert until a cloud config for an Agent is applied to
   * it (`applyConfig`/`replaceOwnerSnapshot`). */
  readonly systemCleaner: SystemCleaner;
  readonly #runtimeInstanceId = crypto.randomUUID();
  /** The consumed cursor and draft ledger; its store says why it is durable. */
  readonly #consumedSeqs: AgentConsumedSeqStore;
  readonly #startedAt = Date.now();
  readonly #agentContexts = new Map<string, string>();
  /** Latest server-authored context-view gate received in a delivery. */
  readonly #contextViewEnabled = new Map<string, boolean>();
  readonly #agentProxyTokens = new Map<string, string>();
  readonly agentApiKeys = new Map<string, string>();
  /** Agents launched with the weekly-report-collect skill pack. */
  readonly #collectSkillAgents = new Set<string>();
  readonly #agentLaunches = new Map<string, Promise<AgentRuntime>>();
  readonly #inputDrain = assembleInputDrain({
    runnerHeld: () => this.#runnerHold !== undefined,
    processManager: () => this.#agentProcessManager,
    launches: () => this.#currentActivityLaunches,
    deliveryGate: () => this.#deliveryGate,
    agentLaunches: () => this.#agentLaunches,
    stopState: () => this.#stopState,
    contextView: () => this,
    mentionDeliveries: () => this.#mentionDeliveries,
    messageAttention: () => this.#messageAttention,
    launchCustody: () => this.#launchCustody,
    abandonLaunch: (agentId, error) => this.#abandonLaunch(agentId, error),
    activityPublisher: () => this.#activityPublisher,
    drafts: () => this.#drafts,
    introducedAgents: () => this.#introducedAgents,
  });
  /** Delivery admission, launch-boundary recovery, and turn-open bookkeeping. */
  readonly #launchCustody: AgentLaunchCustody;
  /** Agents whose current process already received its introduction turn. */
  readonly #introducedAgents = new Set<string>();
  readonly #desktops = createAgentDesktopHolds();
  /** Which Agents are stopping and which Session each launch reported. */
  readonly #stopState = new AgentStopRegistry();
  readonly #currentActivityLaunches = new Map<string, ActivityLaunch>();
  readonly #agentStatusSequences = new Map<string, number>();
  /** The per-Agent offline record a runtime error leaves (`agent-offline-residency.ts`). */
  readonly #offlineResidency = new AgentOfflineResidency({
    endHoldForNextLaunch: (agentId) => this.#deliveryGate.endHoldForNextLaunch(agentId),
    forgetRuntimeErrorHold: (agentId) => this.#runtimeErrorHold.forget(agentId),
    keepInputDeliveriesForNextLaunch: (agentId, error) =>
      this.#exitedDelivery.keepInputDeliveriesForNextLaunch(agentId, error),
    closeAgentInputQueue: (agentId, error) => this.#inputDrain.close(agentId, error),
    buildDraft: (agentId, built) =>
      this.#activity(agentId, built.detailKind, built.level, built.detail, {
        entries: built.entries,
        runtimeError: built.runtimeError,
      }),
    publish: (agentId, launch, draft) => this.#activityPublisher.publish(agentId, launch, draft),
    sendAgentStatus: this.#sendAgentStatus,
    sendAgentActivity: (activity) => this.#transport.sendAgentActivity?.(activity),
    stopProcess: (agentId) => this.#agentProcessManager.stop(agentId),
  });
  readonly #statusReportPorts: AgentStatusReportPorts = {
    agentStatusSequences: this.#agentStatusSequences,
    offlineResidency: this.#offlineResidency,
    transport: () => this.#transport,
    envelope: () => this.#env(),
    runtimeInstanceId: this.#runtimeInstanceId,
    startedAtMs: this.#startedAt,
  };
  readonly #observedUsage = new Map<RuntimeProvider, UsageSnapshot>();
  /** Per-launch context-usage and service-tier readings (`agent-usage-report.ts`). */
  readonly #usageReport = assembleUsageReport(
    (agentId) => this.#stopState.sessionId(agentId),
    () => this.#env(),
    () => this.#runtimeInstanceId,
    (agentId, clientSeq) => this.#agentProcessManager.recordClientSeq(agentId, clientSeq),
    (message) => this.#transport.sendAgentContextUsage?.(message),
    (message) => this.#transport.sendAgentServiceTier?.(message),
  );
  /** Agents warned once per launch that Fast mode was not applied. */
  readonly #fastModeWarned = new Set<string>();
  readonly #agentProxy?: AgentProxy;
  readonly #activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  readonly #replyIntents = new ReplyIntentPublisher<ActivityLaunch>({
    currentLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
    transport: () => this.#transport,
    workspaceId: () => this.#connection.workspaceId,
    active: () => this.#startup.started,
  });
  /** Runner-hold reason, or undefined when turns are admitted. */
  #runnerHold: RunnerHold | undefined;
  /** Each phase's open state and stale watchdog — see `phase-bookkeeping.ts`. */
  readonly #memoryHooks = () => ({
    connection: this.#connection,
    inputDrain: this.#inputDrain,
    session: (agentId: string) => this.#agentProcessManager.session(agentId),
  });
  readonly #contexts = new AgentContexts((agentId) => this.#consumedSeqs.stateDb(agentId));
  readonly #phaseBookkeeping = assemblePhaseBookkeeping(
    this.#contexts,
    (agentId) => this.#currentActivityLaunches.get(agentId),
    (agentId, launch, draft) => this.#activityPublisher.publish(agentId, launch, draft),
    (agentId, detailKind, detail) => this.#activity(agentId, detailKind, "info", detail),
    (agentId) => this.#usageReport.lastContextUsage(agentId),
  );
  /** Provider-event collaborators, assigned after construction. */
  readonly #observationPorts: RuntimeEventObservationPorts;
  readonly #codeAgentInventory: CodeAgentInventorySync;
  readonly #runtimeAuth: RuntimeAuthReporter;
  readonly #upgradeResults: UpgradeResultReporter;
  /** Workspace connection state, assigned after collaborators exist. */
  readonly #startup: RuntimeStartup;
  /** Closing flow, assigned after construction. */
  readonly #shutdown: RuntimeStop;
  /** Cloud-facing Agent operations. */
  readonly #agentOperations: AgentOperations;
  readonly #workspaceQueries = new AgentWorkspaceQueries(
    (agentId) => this.#agentProcessManager.runtime(agentId)?.config.provider,
  );

  constructor(
    connection: DaemonConfig,
    createProvider: CodeAgentProviderFactory,
    credentials: DaemonCredentialStore,
    transportFactory: DaemonConnectionClientFactory,
    agentProxy: AgentProxy | undefined,
    codeAgentDiscovery: CodeAgentDiscovery,
    readonly stateDirectory = ".coforge-daemon-state",
    private readonly lifecycle: DaemonRuntimeLifecycle = {},
    private readonly computerVersion?: string,
    systemCleaner: Pick<
      SystemCleanerOptions,
      "clock" | "measureMemoryFile" | "measureDiskSpace"
    > = {},
    private readonly runtimeAuthFactory: (
      provider: RuntimeAuthProvider,
    ) => RuntimeAuthAdapter = createRuntimeAuthAdapter,
    private readonly releaseChannel?: string,
  ) {
    const runtime = this;
    this.#consumedSeqs = new AgentConsumedSeqStore(this.stateDirectory);
    this.#computerUpdateNotice = new ComputerUpdateNotice(
      this.stateDirectory,
      this.computerVersion,
    );
    this.#activityPublisher = new AgentActivityPublisher<ActivityLaunch>({
      currentLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
      get transport() {
        return runtime.#transport;
      },
      recordClientSeq: (agentId, clientSeq) =>
        this.#agentProcessManager.recordClientSeq(agentId, clientSeq),
      reconcileIdleTurn: this.#reconcileIdleTurn,
    });
    this.#connection = connection;
    this.#contextViewService = new AgentContextViewService({
      stateDirectory,
      serverId: connection.computerId,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      reportAvailability: (availability) =>
        this.#transport.sendAgentContextViewAvailability?.(availability),
    });
    this.#contextViewService.startMaintenance();
    this.#drafts = agentActivityDrafts(connection.workspaceId);
    this.#createProvider = createProvider;
    this.#agentProcessManager = createAgentProcessManager({
      createProvider,
      stateDirectory,
      workspaceId: connection.workspaceId,
      requestLogDirectory: (agentId) => this.#contextViewService.requestLogDirectory(agentId),
    });
    this.#credentials = credentials;
    this.#transportFactory = transportFactory;
    this.#agentProxy = agentProxy;
    const owner = { workspaceId: connection.workspaceId, computerId: connection.computerId };
    this.#runtimeAuth = new RuntimeAuthReporter({
      owner,
      workingDirectory: connection.workspaceRoot,
      transport: () => this.#transport,
      isStopping: () => this.#stopping,
      createAdapter: this.runtimeAuthFactory,
    });
    this.#codeAgentInventory = new CodeAgentInventorySync(
      codeAgentDiscovery,
      owner,
      (transport) => !this.#stopping && this.#transport === transport,
      this.#runtimeAuth,
    );
    this.#transport = transportFactory.create(connection);
    observeLatestComputerVersion(
      this.#transport,
      this.#computerUpdateNotice,
      logComputerUpdateNoticeFailure,
    );
    const messages = composeMessages({
      connection,
      stateDirectory,
      transport: () => this.#transport,
      consumedSeqs: this.#consumedSeqs,
      deliveryGate: this.#deliveryGate,
      runtimeRelease: this.#runtimeRelease,
      processManager: this.#agentProcessManager,
      launchCustody: () => this.#launchCustody,
      activityPublisher: this.#activityPublisher,
      currentActivityLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
      activity: (agentId, detailKind, level, detail, extra) =>
        this.#activity(agentId, detailKind, level, detail, extra),
      sync: this.#sync,
      contexts: this.#contexts,
      memoryAgent: (agentId) => this.memoryFence(agentId),
      reconcileIdleTurn: this.#reconcileIdleTurn,
      startAgent: (agentId, config, sessionId) =>
        this.#startAgent(agentId, config, undefined, { sessionId }),
      assertRunning: () => this.#assertRunning(),
      agentIdForContext: (context) => agentIdForContext(this.#agentContexts, context),
      runningMentionIdentity: (agentId, reported) =>
        this.#runningMentionIdentity(agentId, reported),
    });
    this.agentRequests = assembleAgentRequests({
      transport: () => runtime.#transport,
      connection,
      contexts: this.#contexts,
      authorizedAgent: (context, agentApiKey) => this.#authorizedAgent(context, agentApiKey),
      attention: messages.messageAttention,
    });
    this.#mentionDeliveries = messages.mentionDeliveries;
    this.#messageAttention = messages.messageAttention;
    this.#inboxCoordinator = messages.inboxCoordinator;
    this.#messageOperations = messages.messageOperations;
    const services = composeRuntimeServices({
      connection,
      stateDirectory,
      transport: () => this.#transport,
      envelope: this.#env,
      cleanerInbox: {
        upsert: async (agentId, item) =>
          (await this.#inboxCoordinator.appInbox(agentId)).upsert(item),
        remove: (agentId, itemId) => this.#inboxCoordinator.removeAppItem(agentId, itemId),
      },
      isWorking: (agentId) => this.#isWorking(agentId),
      notifyAppItem: (agentId, itemId) =>
        this.#inboxCoordinator.notifyAppItem(agentId, itemId, { startStopped: false }),
      acceptReminderDue: (job, late) => this.#acceptReminderDue(job, late),
      systemCleaner,
      stopAgent: (agentId) => this.stopAgent(agentId),
      runningAgentIds: () => this.#agentProcessManager.runningAgentIds(),
      forgetLocalAgent: (agentId) => this.#forgetLocalAgent(agentId),
      upgradeResults: this.lifecycle,
    });
    this.#reminders = services.reminders;
    this.systemCleaner = services.systemCleaner;
    this.#appConfigs = services.appConfigs;
    this.#migrations = services.migrations;
    this.#upgradeResults = services.upgradeResults;
    const control = composeAgentControl({
      connection,
      runtimeInstanceId: this.#runtimeInstanceId,
      running: (agentId) => Boolean(this.#agentProcessManager.session(agentId)),
      session: (agentId) => this.#agentProcessManager.session(agentId),
      stopAgent: (agentId) => this.stopAgent(agentId),
      startAgent: (agentId, config, recovery, request) =>
        this.#startAgent(agentId, config, recovery, request),
      rebind: (intent, launchId) => this.#rebindAgent(intent, launchId),
      stops: this.#stopState,
      dropOwedRecovery: (agentId) => this.#launchCoordinator.dropOwedRecovery(agentId),
      startSettled: (agentId) => this.#exitedDelivery.releaseStartBuffer(agentId),
      sendSessionInvalidate: (message) => this.#transport.sendSessionInvalidate?.(message),
      reportSession: (report) => this.#reportAgentSession(report),
      sendControlResult: async (result) => {
        await this.#transport.sendAgentControlResult?.(result);
      },
      agentControlAccepted: () => this.#transport.agentControlAccepted?.() ?? false,
    });
    this.#agentSessions = control.agentSessions;
    this.#agentControl = control.agentControl;
    this.#observationPorts = {
      activityPublisher: this.#activityPublisher,
      deliveryGate: this.#deliveryGate,
      offlineResidency: this.#offlineResidency,
      usageReport: this.#usageReport,
      phaseBookkeeping: this.#phaseBookkeeping,
      runtimeErrorHold: this.#runtimeErrorHold,
      mentionDeliveries: this.#mentionDeliveries,
      agentSessions: this.#agentSessions,
      systemCleaner: this.systemCleaner,
      get idleNudge() {
        return runtime.#launchCoordinator.idleNudge;
      },
      configApply: this.#configApply,
      collectSkillAgents: this.#collectSkillAgents,
      fastModeWarned: this.#fastModeWarned,
      activityDraft: this.#activity,
      runtimeErrorActivity: this.#drafts.runtimeError,
      interruptedActivity: this.#drafts.interrupted,
      showQuietTurn: this.#showQuietTurn,
      reconcileIdleTurn: this.#reconcileIdleTurn,
      wakeFinishedSubagents: (agentId) => runtime.#launchCoordinator.wakeFinishedSubagents(agentId),
      rememberUsage: (snapshot) => rememberUsage(this.#observedUsage, snapshot),
      releaseTurnEndHolds: this.#releaseTurnEndHolds,
      isWorking: this.#isWorking,
      drainAppInboxNotices: (agentId) => this.#inboxCoordinator.drainAppInboxNotices(agentId),
      failCollectorRunningSlots: (agentId, reason) =>
        this.#failCollectorRunningSlots(agentId, reason),
    };
    this.#launchCustody = new AgentLaunchCustody({
      messageAttention: this.#messageAttention,
      deliveryGate: this.#deliveryGate,
      inputDrain: this.#inputDrain,
      agentProcessManager: this.#agentProcessManager,
      currentActivityLaunches: this.#currentActivityLaunches,
      introducedAgents: this.#introducedAgents,
      releaseHeldAppItems: (agentId) => this.#inboxCoordinator.releaseHeldAppItems(agentId),
      releaseFallbackNotices: (agentId) => this.#inboxCoordinator.releaseFallbackNotices(agentId),
    });
    this.#stopCoordinator = new AgentStopCoordinator({
      agentLaunches: this.#agentLaunches,
      currentActivityLaunches: this.#currentActivityLaunches,
      inputDrain: this.#inputDrain,
      processManager: this.#agentProcessManager,
      activityPublisher: this.#activityPublisher,
      desktops: this.#desktops,
      agentApiKeys: this.agentApiKeys,
      revokeAgentApiKey: (agentId, apiKey, scope) =>
        this.#revokeAgentApiKey(agentId, apiKey, scope),
      messageAttention: this.#messageAttention,
      deliveryGate: this.#deliveryGate,
      runtimeErrorHold: this.#runtimeErrorHold,
      offlineResidency: this.#offlineResidency,
      sendAgentStatus: this.#sendAgentStatus,
      publishStopped: (agentId, launch) =>
        this.#activityPublisher.publish(agentId, launch, this.#drafts.stopped(agentId)),
    });
    this.#launchCoordinator = new AgentLaunchCoordinator({
      connection: this.#connection,
      transport: () => this.#transport,
      runtimeInstanceId: this.#runtimeInstanceId,
      agentProcessManager: this.#agentProcessManager,
      sessions: this.#stopState,
      currentActivityLaunches: this.#currentActivityLaunches,
      activityPublisher: this.#activityPublisher,
      phaseBookkeeping: this.#phaseBookkeeping,
      contexts: this.#contexts,
      deliveryGate: this.#deliveryGate,
      usageReport: this.#usageReport,
      fastModeWarned: this.#fastModeWarned,
      sync: this.#sync,
      contextViewGate: (agentId, enabled) => applyContextViewGate(this, agentId, enabled),
      agentApiKeys: this.agentApiKeys,
      agentProxy: this.#agentProxy,
      agentProxyTokens: this.#agentProxyTokens,
      desktops: this.#desktops,
      wakeRecycle: this.#wakeRecycle,
      stops: this.#stopState,
      collectSkillAgents: this.#collectSkillAgents,
      introducedAgents: this.#introducedAgents,
      messageAttention: this.#messageAttention,
      runtimeRelease: this.#runtimeRelease,
      agentControl: this.#agentControl,
      agentSessions: this.#agentSessions,
      runtimeErrorHold: this.#runtimeErrorHold,
      replyIntents: this.#replyIntents,
      offlineResidency: this.#offlineResidency,
      drafts: this.#drafts,
      systemCleaner: this.systemCleaner,
      isStopping: () => this.#stopping,
      assertRunning: () => this.#assertRunning(),
      assertAgentNotStopping: (agentId) => this.#assertAgentNotStopping(agentId),
      contextFor: (agentId) => contextFor(this.#agentContexts, agentId),
      envelope: () => this.#env(),
      reportAgentSession: (report) => this.#reportAgentSession(report),
      sendAgentStatus: this.#sendAgentStatus,
      scheduleStartupFailure: this.#scheduleStartupFailure,
      observeRuntimeEvent: (agentId, launch, config, runtime, managed, event) =>
        this.#observeRuntimeEvent(agentId, launch, config, runtime, managed, event),
      reconcileIdleTurn: this.#reconcileIdleTurn,
      activity: (agentId, detailKind, level, detail, extra) =>
        this.#activity(agentId, detailKind, level, detail, extra),
      narrateUnavailable: (agentId, launch, activity) =>
        this.#narrateUnavailable(agentId, launch, activity),
      disposeLaunchObservations: this.#disposeLaunchObservations,
      revokeLocalLaunch: (agentId, context, proxyToken) =>
        revokeLocalLaunch(
          this.#agentContexts,
          this.#agentProxyTokens,
          this.#agentProxy,
          agentId,
          context,
          proxyToken,
        ),
      revokeAgentApiKey: (agentId, apiKey, scope) =>
        this.#revokeAgentApiKey(agentId, apiKey, scope),
      launchFailureActivity: (agentId, provider, error) =>
        this.#launchFailureActivity(agentId, provider, error),
      appInbox: this.#inboxCoordinator,
      attachSessionMemory: attachFreshSessionMemoryPort(this.#memoryHooks),
      relaunchResumed: (agentId, restart, request) => {
        void this.#wakeAgent(agentId, restart, request).catch(() => {});
      },
    });
    this.#startup = new RuntimeStartup({
      transport: () => this.#transport,
      replaceTransport: () => this.#replaceTransport(),
      credentials: this.#credentials,
      runtimeInstanceId: this.#runtimeInstanceId,
      startedAtMs: this.#startedAt,
      computerVersion: this.computerVersion,
      releaseChannel: this.releaseChannel,
      isStopping: () => this.#stopping,
      publications: {
        startAgent: (intent) => this.handleAgentStart(intent),
        stopAgent: (intent) => this.handleAgentStop(intent),
        applyAgentConfigSync: (sync) => this.handleAgentConfig(sync),
        interruptAgent: (intent) => this.handleAgentTurnInterrupt(intent),
        probeAgent: (probe) => this.handleAgentActivityProbe(probe),
        purgeAgentInbox: (purge) => this.handleAgentInboxPurge(purge),
        resetWorkspace: (request) => this.handleAgentWorkspaceReset(request),
        deliverMessage: (message) => this.handleAgentMessage(message),
        stopRuntime: () => this.stop(),
        connectionRefused: (reason) => this.lifecycle.connectionRefused?.(reason),
        applyReminderSync: (sync) => this.#reminders.apply(sync),
        applyAppConfigSync: (sync) => this.#appConfigs.apply(sync),
        applyAgentServerFeatures: (sync) => this.#sync.applyServerFeatures(sync),
        acceptAppRegistrationNotice: (notice) =>
          acceptAppRegistrationNotice(notice, {
            isRunning: (agentId) => this.#readyRunningAgentIds().includes(agentId),
            mint: (agentId, item) => this.mintAppItem(agentId, item),
          }).then(() => {}),
        migration: migrationRoute(this.#migrations),
      },
      agentControl: this.#agentControl,
      agentSessions: this.#agentSessions,
      configApply: this.#configApply,
      readyRunningAgentIds: () => this.#readyRunningAgentIds(),
      operatingSystem: this.#operatingSystem,
      upgradeResults: this.#upgradeResults,
      runtimeAuth: this.#runtimeAuth,
      runtimeAuthFactory: this.runtimeAuthFactory,
      codeAgentInventory: this.#codeAgentInventory,
      scanUsage: (provider) => this.scanUsage(provider),
      consumeResetCredit: (provider, key) => this.consumeResetCredit(provider, key),
      workspaceQueries: this.#workspaceQueries,
      stateDirectory: this.stateDirectory,
      contextView: this.#contextViewService,
      agentApiKey: (agentId) => this.agentApiKeys.get(agentId),
      resolveProviderSource: (agentId, entry) =>
        resolveContextViewProviderSource(this, agentId, entry),
      deleteWorkspace: (request) => this.#deleteWorkspace(this.#connection, request),
      sendPiChatFrame: async (frame) => {
        if (this.#stopping || !this.#transport.sendPiChatFrame)
          throw new Error("Pi chat connection unavailable");
        await this.#transport.sendPiChatFrame(frame);
      },
      lifecycle: startupLifecycle(
        this.lifecycle,
        this.#upgradeResults,
        this.#connection.workspaceId,
      ),
      requestReminderSnapshot: (agentId) => this.#requestReminderSnapshot(agentId),
      resyncAppConfigs: () => this.#resyncAppConfigs(),
      activityPublisher: this.#activityPublisher,
      coldIdleSweep: this.#coldIdleSweep,
      stalledRecoverySweep: this.#stalledRecoverySweep,
      catalogFreshnessSweep: this.#catalogFreshnessSweep,
      machineStatus: this.#machineStatus,
    });
    this.#agentOperations = new AgentOperations({
      connection: this.#connection,
      transport: () => this.#transport,
      assertRunning: () => this.#assertRunning(),
      assertOwnIntent: (probe) => this.#assertOwnIntent(probe),
      agentIdForContext: (context) => agentIdForContext(this.#agentContexts, context),
      currentActivityLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
      activityPublisher: this.#activityPublisher,
      drafts: this.#drafts,
      activity: (agentId, detailKind, level, detail, extra) =>
        this.#activity(agentId, detailKind, level, detail, extra),
      messageAttention: this.#messageAttention,
      deliveryGate: this.#deliveryGate,
      inputDrain: this.#inputDrain,
      mentionDeliveries: this.#mentionDeliveries,
      launchCustody: this.#launchCustody,
      processManager: this.#agentProcessManager,
      stops: this.#stopState,
      interruptIfBusy: (agentId, launch) => this.#interruptIfBusy(agentId, launch),
      disposeLaunchObservations: this.#disposeLaunchObservations,
      revokeLocalLaunch: (agentId) =>
        revokeLocalLaunch(this.#agentContexts, this.#agentProxyTokens, this.#agentProxy, agentId),
      stopCoordinator: this.#stopCoordinator,
      cleanupUnconfirmed: (agentId, error) => this.#cleanupUnconfirmed(agentId, error),
      messageOperations: this.#messageOperations,
    });
    this.#shutdown = new RuntimeStop({
      startup: this.#startup,
      coldIdleSweep: this.#coldIdleSweep,
      configApply: this.#configApply,
      stalledRecoverySweep: this.#stalledRecoverySweep,
      catalogFreshnessSweep: this.#catalogFreshnessSweep,
      machineStatus: this.#machineStatus,
      activityPublisher: this.#activityPublisher,
      currentActivityLaunches: this.#currentActivityLaunches,
      phaseBookkeeping: this.#phaseBookkeeping,
      runtimeErrorHold: this.#runtimeErrorHold,
      upgradeResults: this.#upgradeResults,
      usageReport: this.#usageReport,
      fastModeWarned: this.#fastModeWarned,
      inputDrain: this.#inputDrain,
      agentLaunches: this.#agentLaunches,
      agentProcessManager: this.#agentProcessManager,
      stops: this.#stopState,
      launchCoordinator: this.#launchCoordinator,
      messageAttention: this.#messageAttention,
      mentionDeliveries: this.#mentionDeliveries,
      reminders: this.#reminders,
      systemCleaner: this.systemCleaner,
      migrations: this.#migrations,
      agentProxy: this.#agentProxy,
      agentProxyTokens: this.#agentProxyTokens,
      agentContexts: this.#agentContexts,
      agentControl: this.#agentControl,
      agentSessions: this.#agentSessions,
      connection: this.#connection,
      transport: () => this.#transport,
      envelope: this.#env,
      runtimeInstanceId: this.#runtimeInstanceId,
      agentApiKeys: this.agentApiKeys,
      revokeAgentApiKey: (agentId, apiKey, scope) =>
        this.#revokeAgentApiKey(agentId, apiKey, scope),
      replaceTransport: () => this.#replaceTransport(),
      consumedSeqs: this.#consumedSeqs,
      sendAgentStatus: this.#sendAgentStatus,
      contextView: this.#contextViewService,
    });
  }

  get agentProcessManager(): AgentProcessManager {
    return this.#agentProcessManager;
  }

  #assertRunning(): void {
    if (this.#stopping || !this.#startup.started)
      throw new AgentPreflightError(NOT_RUNNING, "DAEMON_NOT_RUNNING");
  }

  #assertAgentNotStopping(agentId: string): void {
    if (this.#stopState.stopping(agentId) || this.#agentProcessManager.isStopping(agentId))
      throw new Error(`Agent runtime is stopping: ${agentId}`);
  }

  /** Resolves the Agent behind a local context and checks its API key; the transport is checked by the caller. */
  #authorizedAgent = (context: string, agentApiKey: string | undefined): string => {
    this.#assertRunning();
    const agentId = agentIdForContext(this.#agentContexts, context);
    if (!isAgentApiKey(agentApiKey))
      throw new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING");
    return agentId;
  };

  async scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse> {
    return scanUsage(
      {
        assertRunning: () => this.#assertRunning(),
        workspaceRoot: this.#connection.workspaceRoot,
        createProvider: (provider) => this.#createProvider(provider),
        observedUsage: (provider) => this.#currentObservedUsage(provider),
      },
      provider,
    );
  }

  /** Spends a reset credit of the provider's account and reads its usage again. */
  consumeResetCredit(provider: RuntimeProvider, idempotencyKey: string) {
    return consumeResetCredit(
      {
        assertRunning: () => this.#assertRunning(),
        workspaceRoot: this.#connection.workspaceRoot,
        createProvider: (provider) => this.#createProvider(provider),
        agents: this.#agentProcessManager,
        hold: this.#runtimeErrorHold,
        launchRetries: this.#agentControl,
        launchWaits: this.#offlineResidency,
        wakeCooldowns: this.#wakeLaunchFailures,
      },
      provider,
      idempotencyKey,
    );
  }

  start(connection: DaemonConfig): Promise<void> {
    if (
      connection.workspaceId !== this.#connection.workspaceId ||
      connection.computerId !== this.#connection.computerId
    ) {
      throw new Error("Daemon cannot be started for another Workspace connection");
    }
    if (this.#stopping) return Promise.reject(new DaemonConnectionStoppedError());
    return this.#startup.start(connection);
  }

  #replaceTransport = async (): Promise<unknown> => {
    const runtime = this;
    return replaceTransport({
      get transport() {
        return runtime.#transport;
      },
      set transport(value) {
        runtime.#transport = value;
      },
      transportFactory: this.#transportFactory,
      connection: this.#connection,
    });
  };

  #deleteWorkspace = (
    connection: DaemonConfig,
    request: Pick<AgentWorkspaceDeleteRequest, "agentId">,
  ): Promise<Pick<AgentWorkspaceDeleteResult, "status">> =>
    deleteWorkspace(
      connection,
      request,
      this.#agentProcessManager,
      (agentId) => this.stopAgent(agentId),
      (agentId) => this.#forgetLocalAgent(agentId),
    );

  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    sessionId?: string,
    requestId?: string,
    recovery?: AgentRecoveryContext,
    previousLaunchId?: string,
    sessionMode?: SessionMode,
    control?: { controlEpoch?: number; launchId: string },
    replacedSessionId?: string,
  ): Promise<AgentRuntime> {
    return this.#startAgent(agentId, config, recovery, {
      sessionId,
      requestId,
      previousLaunchId,
      sessionMode,
      control,
      replacedSessionId,
    });
  }

  #startAgent = (
    agentId: string,
    config: AgentRuntimeConfig,
    recovery: AgentRecoveryContext | undefined,
    request: LaunchRequest,
  ): Promise<AgentRuntime> =>
    startAgent(
      {
        assertRunning: () => this.#assertRunning(),
        assertAgentNotStopping: (id) => this.#assertAgentNotStopping(id),
        migrations: this.#migrations,
        requestAppConfigSnapshot: (id) => this.#requestAppConfigSnapshot(id),
        inputDrain: this.#inputDrain,
        introducedAgents: this.#introducedAgents,
        agentLaunches: this.#agentLaunches,
        agentProcessManager: this.#agentProcessManager,
        runnerHold: this.#runnerHold,
        messageAttention: this.#messageAttention,
        wakeLaunchFailures: this.#wakeLaunchFailures,
        launchCoordinator: this.#launchCoordinator,
        exitedDelivery: this.#exitedDelivery,
        releaseSurvivingHolds: (id) => this.#releaseSurvivingHolds(id),
        sessions: this.#stopState,
        configApply: this.#configApply,
      },
      agentId,
      config,
      recovery,
      request,
    );

  #messageDeliveryPorts() {
    return {
      assertRunning: () => this.#assertRunning(),
      workspaceId: this.#connection.workspaceId,
      stops: this.#stopState,
      runnerHold: this.#runnerHold,
      runtimeRelease: this.#runtimeRelease,
      sync: this.#sync,
      exitedDelivery: this.#exitedDelivery,
      wakeLaunches: this.#wakeLaunches,
      agentLaunches: this.#agentLaunches,
      deliveryGate: this.#deliveryGate,
      launchCustody: this.#launchCustody,
      inputDrain: this.#inputDrain,
      agentProcessManager: this.#agentProcessManager,
      mentionDeliveries: this.#mentionDeliveries,
    };
  }

  #appInboxSyncPorts() {
    return {
      transport: () => this.#transport,
      appConfigs: this.#appConfigs,
      reminders: this.#reminders,
      inboxCoordinator: this.#inboxCoordinator,
      env: () => this.#env(),
      readyRunningAgentIds: () => this.#readyRunningAgentIds(),
      launchingAgentIds: this.#agentLaunches.keys(),
    };
  }

  #agentApiRemindersPorts() {
    return {
      assertRunning: () => this.#assertRunning(),
      agentIdForContext: (context: string) => agentIdForContext(this.#agentContexts, context),
      transport: () => this.#transport,
      workspaceId: this.#connection.workspaceId,
      computerId: this.#connection.computerId,
      messageAttention: this.#messageAttention,
      reminders: this.#reminders,
      inboxCoordinator: this.#inboxCoordinator,
    };
  }

  #env = () => runtimeEnvelope(this.#connection);

  /** Tears down a launch whose recovery notice was rejected; returns the error to surface. */
  async #abandonLaunch(agentId: string, error: unknown): Promise<unknown> {
    return abandonLaunch(this.#startupFailurePorts(), agentId, error);
  }

  #scheduleStartupFailure = (agentId: string, launch: ActivityLaunch): void =>
    scheduleStartupFailure(this.#startupFailurePorts(), agentId, launch);

  #startupFailurePorts() {
    return {
      stopping: this.#stopping,
      stops: this.#stopState,
      inputDrain: this.#inputDrain,
      currentActivityLaunches: this.#currentActivityLaunches,
      interruptIfBusy: (id: string, current: ActivityLaunch | undefined) =>
        this.#interruptIfBusy(id, current),
      activityPublisher: this.#activityPublisher,
      disposeLaunchObservations: this.#disposeLaunchObservations,
      revokeLocalLaunch: (id: string) =>
        revokeLocalLaunch(this.#agentContexts, this.#agentProxyTokens, this.#agentProxy, id),
      offlineResidency: this.#offlineResidency,
      stopCoordinator: this.#stopCoordinator,
      drafts: this.#drafts,
      agentControl: this.#agentControl,
    };
  }

  /**
   * The one-line delegate; the path's contract lives on `rebindAgent` in agent-rebind.ts. */
  async #rebindAgent(
    intent: AgentStartIntent,
    launchId: string,
  ): Promise<SessionIdentity | undefined> {
    return rebindAgent(
      {
        currentActivityLaunches: this.#currentActivityLaunches,
        sessions: this.#stopState,
        agentProcessManager: this.#agentProcessManager,
        runtimeInstanceId: this.#runtimeInstanceId,
        envelope: () => this.#env(),
        reportAgentSession: (report) => this.#reportAgentSession(report),
        sendAgentStatus: this.#sendAgentStatus,
      },
      intent,
      launchId,
    );
  }

  /** Translates one coalesced provider event into cloud Activity, Session and usage updates. */
  #observeRuntimeEvent = launchEventObserver(() => ({
    currentLaunch: (id) => this.#currentActivityLaunches.get(id),
    observation: this.#observationPorts,
  }));

  #failCollectorRunningSlots = (agentId: string, failureReason: string) =>
    failCollectorRunningSlots(this.#transport, this.agentApiKeys, agentId, failureReason);

  #currentObservedUsage = (provider: RuntimeProvider) =>
    currentObservedUsage(this.#observedUsage, provider);

  #assertOwnIntent = (intent: {
    protocolMajor: number;
    workspaceId: string;
    computerId?: string;
  }) => assertOwnIntent(intent, this.#connection.workspaceId, this.#connection.computerId);

  async handleAgentStart(intent: AgentStartIntent): Promise<AgentRuntime> {
    return handleAgentStart(this.#controlIntentPorts(), intent);
  }

  #controlIntentPorts(): AgentControlIntentPorts {
    return controlIntentPorts({
      assertOwnIntent: this.#assertOwnIntent,
      connection: this.#connection,
      started: this.#startup.started,
      stopping: this.#stopping,
      agentControl: this.#agentControl,
      agentSessions: this.#agentSessions,
      processes: this.#agentProcessManager,
      stops: this.#stopState,
      launchCoordinator: this.#launchCoordinator,
      startAgent: this.#startAgent,
      stopAgent: (agentId) => this.stopAgent(agentId),
    });
  }

  async handleAgentWorkspaceReset(request: AgentWorkspaceResetRequest): Promise<void> {
    return handleAgentWorkspaceReset(this.#controlIntentPorts(), request);
  }

  async handleAgentStop(intent: AgentStopIntent): Promise<void> {
    return handleAgentStop(this.#controlIntentPorts(), intent);
  }

  /** A pushed runtime configuration: applied when the Agent is next idle, never by cutting a
   * turn short. */
  async handleAgentConfig(sync: AgentConfigSync): Promise<void> {
    this.#assertOwnIntent(sync);
    await this.#configApply.accept(sync);
  }

  async handleAgentTurnInterrupt(intent: AgentTurnInterruptIntent): Promise<void> {
    return handleAgentTurnInterrupt(
      {
        assertOwnIntent: (intent) => this.#assertOwnIntent(intent),
        launch: (agentId) => this.#currentActivityLaunches.get(agentId),
        interrupt: (agentId, options) => this.#agentProcessManager.interruptTurn(agentId, options),
        interruptSubagent: (agentId, taskId) =>
          this.#agentProcessManager.interruptSubagent(agentId, taskId),
        publish: (agentId, launch, draft) =>
          this.#activityPublisher.publish(agentId, launch, draft),
        activity: (agentId, detailKind, level, detail) =>
          this.#activity(agentId, detailKind as AgentActivity["detailKind"], level, detail),
        interruptedDraft: (agentId) => this.#drafts.interrupted(agentId),
        report: this.#transport.sendAgentTurnInterruptResult?.bind(this.#transport),
      },
      intent,
    );
  }

  /** Answers a liveness probe from current Agent activity without mutating runtime state. */
  async handleAgentActivityProbe(probe: AgentActivityProbe): Promise<void> {
    return this.#agentOperations.handleActivityProbe(probe);
  }

  async handleAgentMessage(message: AgentMessageDelivery): Promise<void> {
    return handleAgentMessage(this.#messageDeliveryPorts(), message);
  }

  /** Launch/session identity used by tracked mentions. */
  #runningMentionIdentity(agentId: string, reported?: true): RunningMentionIdentity | undefined {
    return reported
      ? this.#reported.last(agentId)
      : this.#reported.running(agentId, this.#agentProcessManager, this.#currentActivityLaunches);
  }

  /** Sends a session report, and remembers the launch and session it names for tracked
   * mentions. */
  async #reportAgentSession(report: AgentSessionReport): Promise<void> {
    await this.#transport.reportAgentSession?.(report);
    this.#reported.remember(report);
    await reportContextViewAvailability(this, report);
  }

  get service(): AgentContextViewService {
    return this.#contextViewService;
  }
  get enabled(): Map<string, boolean> {
    return this.#contextViewEnabled;
  }
  runtime(agentId: string) {
    return this.#agentProcessManager.runtime(agentId);
  }
  restartConfig(agentId: string) {
    return this.#agentProcessManager.restartConfig(agentId);
  }
  get workspaceRoot(): string {
    return this.#connection.workspaceRoot;
  }
  reported(agentId: string) {
    return this.#reported.last(agentId);
  }

  #wakeAgent = (
    agentId: string,
    restart: WakeRestart,
    request = wakeRequest(restart),
  ): Promise<AgentRuntime> =>
    beginWakeLaunch(
      agentId,
      this.#startAgent(agentId, restart.config, undefined, request),
      this.#wakeLaunches,
      this.#wakeLaunchFailures,
    );

  /** Drops local state for channels an Agent can no longer read. */
  handleAgentInboxPurge(purge: AgentInboxPurge): void {
    return this.#agentOperations.handleInboxPurge(purge);
  }

  stopAgent(agentId: string): Promise<void> {
    this.#configApply.stopped(agentId);
    return this.#agentOperations.stopAgent(agentId);
  }

  /** Forgets one ended launch's observation state without affecting another Agent. */
  #disposeLaunchObservations = (agentId: string): void => {
    disposeLaunchObservations(
      agentId,
      this.#currentActivityLaunches,
      this.#phaseBookkeeping,
      this.#usageReport,
      this.#fastModeWarned,
    );
  };

  #readyRunningAgentIds = (): string[] =>
    readyRunningAgentIds(this.#agentProcessManager, this.#agentLaunches, this.#stopState);

  #activity = (
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra: Partial<ActivityDraft> = {},
  ): ActivityDraft =>
    activityDraft(this.#connection.workspaceId, agentId, detailKind, level, detail, extra);

  #turnPorts = () => ({
    messageAttention: this.#messageAttention,
    activityPublisher: this.#activityPublisher,
    deliveryGate: this.#deliveryGate,
    inboxCoordinator: this.#inboxCoordinator,
    launchCustody: this.#launchCustody,
    processManager: this.#agentProcessManager,
    currentActivityLaunches: this.#currentActivityLaunches,
    phaseBookkeeping: this.#phaseBookkeeping,
    runtimeRelease: this.#runtimeRelease,
    systemCleaner: this.systemCleaner,
    idleNudge: this.#launchCoordinator.idleNudge,
    configApply: this.#configApply,
    drafts: this.#drafts,
    activity: (
      agentId: string,
      kind: AgentActivity["detailKind"],
      level: AgentActivity["level"],
      detail: string,
      extra?: Partial<ActivityDraft>,
    ) => this.#activity(agentId, kind, level, detail, extra),
    isWorking: (agentId: string) => isWorking(this.#turnPorts(), agentId),
  });

  #narrateUnavailable = (
    agentId: string,
    launch: ActivityLaunch,
    { detail, entryText }: { detail: string; entryText?: string },
  ): void => narrateUnavailable(this.#turnPorts(), agentId, launch, detail, entryText);
  #interruptIfBusy = (agentId: string, activityLaunch: ActivityLaunch | undefined): void =>
    interruptIfBusy(this.#turnPorts(), agentId, activityLaunch);
  #showQuietTurn = (
    agentId: string,
    launch: ActivityLaunch,
    publish: (agentId: string, launch: ActivityLaunch, activity: ActivityDraft) => void,
  ): void => showQuietTurn(this.#turnPorts(), agentId, launch, publish);
  #reconcileIdleTurn = (agentId: string, launch: ActivityLaunch): boolean =>
    reconcileIdleTurn(this.#turnPorts(), agentId, launch);
  #releaseSurvivingHolds = (agentId: string): void =>
    releaseSurvivingHolds(this.#turnPorts(), agentId);
  #releaseTurnEndHolds = (agentId: string): void => releaseTurnEndHolds(this.#turnPorts(), agentId);

  /** The Agent no longer lives on this Computer: its workspace was deleted or moved away. */
  #forgetLocalAgent = (agentId: string): void =>
    forgetAgent(
      agentId,
      this.#contextViewEnabled,
      this.#contextViewService,
      this.#inboxCoordinator,
      this.systemCleaner,
      this.#offlineResidency,
      this.#messageAttention,
      this.#consumedSeqs,
      this.#sync,
      (agentId) => this.#launchCoordinator.dropOwedRecovery(agentId),
    );

  #cleanupUnconfirmed = (agentId: string, error: unknown): boolean =>
    cleanupUnconfirmed(agentId, error, (id) => this.#agentProcessManager.isStopping(id));

  /** The error Activity for a launch that did not start; `agent-failure-presentation` builds it. */
  #launchFailureActivity = (agentId: string, provider: RuntimeProvider, error: unknown) =>
    buildLaunchFailureActivity(agentId, provider, error, this.#drafts, (id) =>
      this.#agentProcessManager.isStopping(id),
    );

  get #revokeAgentApiKey() {
    return revokeAgentApiKey.bind(undefined, this.#transport, this.agentApiKeys);
  }

  async agentMessage(
    context: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    return this.#agentOperations.agentMessage(context, request, agentApiKey);
  }

  /** `coforge version`'s local-only query; the answer body lives in `runtime-local-queries`. */
  async version(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentVersionResponse> {
    this.#authorizedAgent(context, agentApiKey);
    return localVersionResponse({
      computerVersion: this.computerVersion,
      startedAt: this.#startedAt,
    });
  }

  /** The deduped Computer-update notice line for a CLI's output tail; assembled locally. */
  async computerUpdateNotice(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<{ ok: true; notice: string | null }> {
    this.#authorizedAgent(context, agentApiKey);
    return localComputerUpdateNotice(this.#computerUpdateNotice);
  }

  memoryFence(agentId: string): string | undefined {
    return (
      this.#agentProcessManager.runtime(agentId)?.config.toolProfile ??
      this.#agentProcessManager.restartConfig(agentId)?.config.toolProfile
    );
  }

  /** Dispatches one task command to the cloud task route over its HTTPS path. */
  async agentTask(context: string, command: TaskCommand, agentApiKey: string): Promise<TaskResult> {
    return agentTask(this.#agentApiRemindersPorts(), context, command, agentApiKey);
  }

  async mintAppItem(agentId: string, input: MintAppItem) {
    return mintAppItem(this.#agentApiRemindersPorts(), agentId, input);
  }

  async reminder(context: string, request: LocalReminderRequest, agentApiKey: string) {
    return reminder(this.#agentApiRemindersPorts(), context, request, agentApiKey);
  }

  #acceptReminderDue = (job: ReminderJob, late: boolean): Promise<boolean> =>
    acceptReminderDue(this.#agentApiRemindersPorts(), job, late);

  #resyncAppConfigs(): void {
    resyncAppConfigs(this.#appInboxSyncPorts());
  }

  #requestAppConfigSnapshot(agentId: string): void {
    requestAppConfigSnapshot(this.#appInboxSyncPorts(), agentId);
  }

  async #requestReminderSnapshot(agentId: string): Promise<void> {
    return requestReminderSnapshot(this.#appInboxSyncPorts(), agentId);
  }

  async inbox(context: string, request: LocalInboxRequest): Promise<InboxResponse> {
    return inbox(this.#appInboxSyncPorts(), context, request);
  }

  async drainAppInboxNotices(agentId: string): Promise<void> {
    return drainAppInboxNotices(this.#appInboxSyncPorts(), agentId);
  }

  issueAgentContext(agentId: string, context: string = crypto.randomUUID()): string {
    this.#assertRunning();
    this.#agentContexts.set(agentId, context);
    void this.#requestReminderSnapshot(agentId).catch(() => {});
    return context;
  }

  #runnerHoldCell() {
    const runtime = this;
    return {
      get hold() {
        return runtime.#runnerHold;
      },
      set hold(value) {
        runtime.#runnerHold = value;
      },
    };
  }

  /** Stops admitting new Agent turns and reports which Agents are still busy. */
  holdRunners(reason: RunnerHoldReason): BusyAgentReport[] {
    return holdRunners(this.#runnerHoldCell(), reason, this.#activityPublisher);
  }

  /** Lifts the hold and resumes every delivery queued behind it, in arrival order. */
  releaseRunners(): BusyAgentReport[] {
    return releaseRunners(
      this.#runnerHoldCell(),
      this.#activityPublisher,
      this.#inputDrain,
      this.#agentProcessManager,
      this.#agentLaunches,
      this.#mentionDeliveries,
    );
  }

  get runnerHeld(): boolean {
    return this.#runnerHold !== undefined;
  }

  /** Agents whose last emitted Activity is a busy detail kind with no terminal kind since. */
  busyAgents(): BusyAgentReport[] {
    return this.#activityPublisher.busyAgents();
  }

  /** Why this runtime's cloud connection last failed to connect, while it is not up. */
  cloudConnectFailure(): string | undefined {
    return this.#transport.connectFailure?.();
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    const shutdownReason = shutdownReasonForHold(
      this.#runnerHold,
      Date.now(),
      this.lifecycle.installerJournalExists ?? (() => false),
    );
    this.#runnerHold = undefined;
    this.#stopping = true;
    this.#stopPromise = this.#shutdown.run(shutdownReason).finally(() => {
      this.#stopPromise = undefined;
      this.#stopping = false;
    });
    return this.#stopPromise;
  }
}

export type { CodeAgentProviderFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
export type { BusyAgentReport };
