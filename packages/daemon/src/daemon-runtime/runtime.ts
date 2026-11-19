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
import { launchInputPorts } from "./session-memory-hooks";
import { LocalMemoryRuntime } from "./local-memory-runtime";
import { rebindAgent } from "./agent-rebind";
import { AgentLaunchCustody } from "./agent-launch-custody";
import { AgentContexts } from "./agent-contexts";
import { assemblePhaseBookkeeping } from "./phase-bookkeeping-wiring";
import { type RuntimeEventObservationPorts } from "./runtime-event-observation-ports";
import {
  launchEventObserver,
  handleAgentStart,
  handleAgentStop,
  controlPublications,
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
export type { DaemonConfig } from "./runtime-connection-config";
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
import { RuntimeLocalQueries } from "#src/daemon-runtime/runtime-local-queries";
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
  type TaskCommand,
  type TaskResult,
  type AgentWorkspaceDeleteRequest,
  type AgentWorkspaceDeleteResult,
} from "@lrm/coforge-sdk/internal";
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
import { agentTask, mintAppItem, reminder } from "./runtime-agent-api-reminders";
import {
  drainAppInboxNotices,
  inbox,
  requestAppConfigSnapshot,
  resyncAppConfigs,
} from "./runtime-app-inbox-sync";
import { handleAgentMessage } from "./runtime-message-delivery";
import { RuntimeTurn } from "./runtime-turn-management";
import { abandonLaunch, scheduleStartupFailure } from "./agent-startup-failure";
import { revokeAgentApiKey } from "./agent-api-key-revoke";
import { assembleRuntimeSweeps, createSessionSummaryObserver } from "./assemble-runtime-sweeps";
import { assembleAgentConfigApply } from "./agent-config-apply-assembly";
import { rememberUsage } from "./usage-memory";
import { runtimeMachineStatus } from "./machine-status-reporter";
import { agentActivityDrafts } from "./agent-activity-drafts";
import { sendAgentStatus, type AgentStatusReportPorts } from "./agent-status-report";
import { agentIdForContext, contextFor } from "./agent-context";
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
import { assembleCredentialHolds } from "./assemble-credential-holds";
import { AgentLifecycle } from "./agent-lifecycle";
import { consumeResetCredit } from "./reset-credit-consume";
import type { ActivityLaunch } from "./activity-launch";
import { AgentOfflineResidency } from "./agent-offline-residency";
import { AgentExitedDelivery } from "./agent-exited-delivery";
import { assembleUsageReport } from "./agent-usage-report-wiring";
import { MentionDeliveryTracker } from "./mention-delivery-tracker";
import { ReportedSessions } from "./reported-sessions";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type { MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import type { SystemCleaner, SystemCleanerOptions } from "#src/system-cleaner/system-cleaner";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import { AgentPreflightError, NOT_RUNNING } from "./agent-preflight-error";
import { launchFailureActivity } from "./runtime-launch-failure-activity";
import { shutdownReasonForHold, type RunnerHold } from "./shutdown-reason";
import { CodeAgentInventorySync, type CodeAgentDiscovery } from "./code-agent-inventory-sync";
import { RuntimeAuthReporter } from "./runtime-auth-reporter";
import { RuntimeStartup } from "./runtime-startup";
import { RuntimeStop } from "./runtime-stop";
import { composeMessages } from "./message-composition";
import { assembleExitedDelivery } from "./assemble-exited-delivery";
import {
  composeRuntimeServices,
  migrationRoute,
  type RuntimeServices,
} from "./runtime-services-composition";
import { AgentOperations } from "./agent-operations";
import { composeAgentControl } from "./agent-control-composition";
import {
  liveHoldCell,
  withIdleNudge,
  withLiveTransport,
  withMutableTransport,
} from "./runtime-accessors";
import type { DaemonRuntimeLifecycle } from "./runtime-lifecycle";
import { logComputerUpdateNoticeFailure } from "./agent-failure-logs";
import { acceptAppRegistrationNotice } from "#src/agent-app-inbox/app-registration-notice";

export { USAGE_SCAN_READ_TIMEOUT_MS } from "./runtime-agent-flows";

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
  readonly agentRequests: AgentRequestForwarder;
  readonly #mentionDeliveries: MentionDeliveryTracker;
  readonly #reported = new ReportedSessions(
    () => this.#agentProcessManager,
    () => this.#currentActivityLaunches,
  );
  readonly #contextViewService: AgentContextViewService;
  readonly localQueries: RuntimeLocalQueries;
  readonly #deliveryGate = new AgentDeliveryGate();
  readonly #wakeLaunchFailures = new LaunchFailureBackoff();
  readonly #turn = new RuntimeTurn(() => this.#turnPorts());
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
    working: this.#turn.isWorking,
    deliveryGate: () => this.#deliveryGate,
    agentLaunches: () => this.#agentLaunches,
    stopState: () => this.#stopState,
    runnerHold: () => this.#runnerHold,
    migrations: () => this.#services.migrations,
    runningMentionIdentity: (agentId) => this.#reported.identity(agentId),
    noticeActionClocks: () => this.#messageAttention.noticeActionClocks,
    releaseSurvivingHolds: (agentId) => this.#turn.releaseSurvivingHolds(agentId),
    wakeAgent: (agentId, restart) => this.#wakeAgent(agentId, restart),
    mentionDeliveries: () => this.#mentionDeliveries,
  });

  readonly #sweeps = assembleRuntimeSweeps({
    processManager: () => this.#agentProcessManager,
    runtimeRelease: () => this.#runtimeRelease,
    createProvider: (provider) => this.#createProvider(provider),
    contexts: () => this.#contexts,
    deliveryGate: () => this.#deliveryGate,
    runnerHold: () => this.#runnerHold !== undefined,
    stopState: () => this.#stopState,
    activeTransport: () => (this.#startup.started && !this.#stopping ? this.#transport : undefined),
    inventory: () => this.#codeAgentInventory,
  });

  readonly #configApply = assembleAgentConfigApply({
    runtimeRelease: () => this.#runtimeRelease,
    processManager: () => this.#agentProcessManager,
    agentLaunches: () => this.#agentLaunches,
    activityLaunches: () => this.#currentActivityLaunches,
    credentialHolds: () => this.#credentialHolds,
  });

  readonly #operatingSystem = new OperatingSystemInfo();

  readonly #machineStatus = runtimeMachineStatus({
    connection: () => this.#connection,
    dataDirectory: () => this.stateDirectory,
    transport: () => (this.#startup.started && !this.#stopping ? this.#transport : undefined),
  });
  readonly #wakeRecycle = new WakeRecycle({
    provider: (provider) => this.#createProvider(provider),
    inputQueue: (agentId) => this.#inputDrain.get(agentId),
    hasQueuedDeliveries: (agentId) => this.#deliveryGate.hasQueued(agentId),
    readSummaryFacts: (agentId, sessionId) => this.#contexts.sessionResumeFacts(agentId, sessionId),
  });

  readonly #lifecycle = new AgentLifecycle();

  readonly #credentialHolds = assembleCredentialHolds({
    deliveryGate: this.#deliveryGate,
    lifecycle: this.#lifecycle,
    errorHold: () => this.#runtimeErrorHold,
    processManager: () => this.#agentProcessManager,
    launches: () => this.#currentActivityLaunches,
    activityPublisher: () => this.#activityPublisher,
    activity: (agentId, kind, level, detail) => this.#activity(agentId, kind, level, detail),
    workspaceId: () => this.#connection.workspaceId,
    presentKept: (agentId) => void this.#launchCustody.flushSurvivingDeliveries(agentId),
    wake: (agentId) => this.#exitedDelivery.backoffEnded(agentId),
    transport: () => this.#transport,
  });
  readonly #runtimeErrorHold = assembleRuntimeErrorDeliveryHold({
    stateDirectory: () => this.stateDirectory,
    deliveryGate: this.#deliveryGate,
    flush: this.#turn.flushHeld,
    backoffEnded: (agentId) => this.#exitedDelivery.backoffEnded(agentId),
    credential: this.#credentialHolds,
  });
  readonly #services: RuntimeServices;

  readonly #inboxCoordinator: AgentInboxCoordinator;
  readonly #stopCoordinator: AgentStopCoordinator;
  readonly #launchCoordinator: AgentLaunchCoordinator;

  readonly systemCleaner: SystemCleaner;
  readonly #runtimeInstanceId = crypto.randomUUID();
  readonly #consumedSeqs: AgentConsumedSeqStore;
  readonly #startedAt = Date.now();
  readonly #agentContexts = new Map<string, string>();
  readonly #contextViewEnabled = new Map<string, boolean>();
  readonly #agentProxyTokens = new Map<string, string>();
  readonly agentApiKeys = new Map<string, string>();
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
    abandonLaunch: (agentId, error) => abandonLaunch(this.#startupFailurePorts(), agentId, error),
    activityPublisher: () => this.#activityPublisher,
    drafts: () => this.#drafts,
    introducedAgents: () => this.#introducedAgents,
  });
  readonly #launchCustody: AgentLaunchCustody;
  readonly #introducedAgents = new Set<string>();
  readonly #desktops = createAgentDesktopHolds();
  readonly #stopState = new AgentStopRegistry();
  readonly #currentActivityLaunches = new Map<string, ActivityLaunch>();
  readonly #agentStatusSequences = new Map<string, number>();

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

  readonly #usageReport = assembleUsageReport(
    (agentId) => this.#stopState.sessionId(agentId),
    () => this.#env(),
    () => this.#runtimeInstanceId,
    (agentId, clientSeq) => this.#agentProcessManager.recordClientSeq(agentId, clientSeq),
    (message) => this.#transport.sendAgentContextUsage?.(message),
    (message) => this.#transport.sendAgentServiceTier?.(message),
  );

  readonly #fastModeWarned = new Set<string>();
  readonly #agentProxy?: AgentProxy;
  readonly #activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  readonly #replyIntents = new ReplyIntentPublisher<ActivityLaunch>({
    currentLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
    transport: () => this.#transport,
    workspaceId: () => this.#connection.workspaceId,
    active: () => this.#startup.started,
  });

  #runnerHold: RunnerHold | undefined;

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

  readonly #observationPorts: RuntimeEventObservationPorts;
  readonly #codeAgentInventory: CodeAgentInventorySync;
  readonly #runtimeAuth: RuntimeAuthReporter;

  readonly #startup: RuntimeStartup;

  readonly #shutdown: RuntimeStop;

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
    this.#consumedSeqs = new AgentConsumedSeqStore(this.stateDirectory);
    this.#computerUpdateNotice = new ComputerUpdateNotice(
      this.stateDirectory,
      this.computerVersion,
    );
    this.#activityPublisher = new AgentActivityPublisher<ActivityLaunch>(
      withLiveTransport(() => this.#transport, {
        currentLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
        recordClientSeq: (agentId, clientSeq) =>
          this.#agentProcessManager.recordClientSeq(agentId, clientSeq),
        reconcileIdleTurn: this.#turn.reconcileIdleTurn,
      }),
    );
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
      sweeps: this.#sweeps,
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
      reconcileIdleTurn: this.#turn.reconcileIdleTurn,
      startAgent: (agentId, config, sessionId) =>
        this.#startAgent(agentId, config, undefined, { sessionId }),
      assertRunning: () => this.#assertRunning(),
      agentIdForContext: (context) => agentIdForContext(this.#agentContexts, context),
      runningMentionIdentity: (agentId, reported) => this.#reported.identity(agentId, reported),
    });
    this.agentRequests = assembleAgentRequests({
      transport: () => this.#transport,
      connection,
      contexts: this.#contexts,
      authorizedAgent: (context, agentApiKey) => this.#authorizedAgent(context, agentApiKey),
      attention: messages.messageAttention,
    });
    this.#mentionDeliveries = messages.mentionDeliveries;
    this.#messageAttention = messages.messageAttention;
    this.#inboxCoordinator = messages.inboxCoordinator;
    this.#messageOperations = messages.messageOperations;
    this.#services = composeRuntimeServices({
      connection,
      stateDirectory,
      transport: () => this.#transport,
      agentApiKeys: this.agentApiKeys,
      envelope: this.#env,
      cleanerInbox: {
        upsert: async (agentId, item) =>
          (await this.#inboxCoordinator.appInbox(agentId)).upsert(item),
        remove: (agentId, itemId) => this.#inboxCoordinator.removeAppItem(agentId, itemId),
      },
      isWorking: (agentId) => this.#turn.isWorking(agentId),
      notifyAppItem: (agentId, itemId) =>
        this.#inboxCoordinator.notifyAppItem(agentId, itemId, { startStopped: false }),
      reminderInbox: () => this.#agentApiRemindersPorts(),
      systemCleaner,
      stopAgent: (agentId) => this.stopAgent(agentId),
      runningAgentIds: () => this.#agentProcessManager.runningAgentIds(),
      forgetLocalAgent: (agentId) => this.#forgetLocalAgent(agentId),
      upgradeResults: this.lifecycle,
    });
    this.systemCleaner = this.#services.systemCleaner;
    this.localQueries = new RuntimeLocalQueries(
      this,
      this.computerVersion,
      this.#startedAt,
      this.#computerUpdateNotice,
      this.#services.procJobs,
    );
    const control = composeAgentControl({
      connection,
      runtimeInstanceId: this.#runtimeInstanceId,
      running: (agentId) =>
        !this.#stopState.isStopping(agentId) && this.#agentProcessManager.isRunning(agentId),
      session: (agentId) => this.#agentProcessManager.session(agentId),
      stopAgent: (agentId) => this.stopAgent(agentId),
      stopAgentJobs: (agentId) => this.stopAgentJobs(agentId),
      startAgent: (agentId, config, recovery, request) =>
        this.#startAgent(agentId, config, recovery, request),
      launchInFlight: (agentId) => this.#agentLaunches.get(agentId),
      rebind: (intent, launchId) => this.#rebindAgent(intent, launchId),
      stops: this.#stopState,
      dropOwedRecovery: (agentId) => this.#launchCoordinator.dropOwedRecovery(agentId),
      startSettled: (agentId) => this.#exitedDelivery.releaseStartBuffer(agentId),
      reportSession: (report) => this.#reportAgentSession(report),
      transport: () => this.#transport,
      onVersionUnsupported: (provider) =>
        void this.#codeAgentInventory.reprobe(provider, "launch_refused", this.#transport),
    });
    this.#agentSessions = control.agentSessions;
    this.#agentControl = control.agentControl;
    this.#observationPorts = this.#createObservationPorts();
    this.#launchCustody = this.#createLaunchCustody();
    this.#stopCoordinator = this.#createStopCoordinator();
    this.#launchCoordinator = this.#createLaunchCoordinator();
    this.#startup = this.#createStartup();
    this.#agentOperations = this.#createAgentOperations();
    this.#shutdown = this.#createShutdown();
  }

  #createObservationPorts(): RuntimeEventObservationPorts {
    return withIdleNudge(() => this.#launchCoordinator.idleNudge, {
      activityPublisher: this.#activityPublisher,
      deliveryGate: this.#deliveryGate,
      offlineResidency: this.#offlineResidency,
      usageReport: this.#usageReport,
      phaseBookkeeping: this.#phaseBookkeeping,
      runtimeErrorHold: this.#runtimeErrorHold,
      credentialHolds: this.#credentialHolds,
      mentionDeliveries: this.#mentionDeliveries,
      agentSessions: this.#agentSessions,
      systemCleaner: this.systemCleaner,
      configApply: this.#configApply,
      sessionSummary: createSessionSummaryObserver(
        this.#contexts,
        (agentId) => this.#stopState.sessionId(agentId),
        this.#createProvider,
      ),
      collectSkillAgents: this.#collectSkillAgents,
      fastModeWarned: this.#fastModeWarned,
      activityDraft: this.#activity,
      runtimeErrorActivity: this.#drafts.runtimeError,
      interruptedActivity: this.#drafts.interrupted,
      showQuietTurn: this.#turn.showQuietTurn,
      reconcileIdleTurn: this.#turn.reconcileIdleTurn,
      wakeFinishedSubagents: (agentId) => this.#launchCoordinator.wakeFinishedSubagents(agentId),
      rememberUsage: (snapshot) => rememberUsage(this.#observedUsage, snapshot),
      releaseTurnEndHolds: this.#turn.releaseTurnEndHolds,
      isWorking: this.#turn.isWorking,
      drainAppInboxNotices: (agentId) => this.#inboxCoordinator.drainAppInboxNotices(agentId),
      failCollectorRunningSlots: (agentId, reason) =>
        failCollectorRunningSlots(this.#transport, this.agentApiKeys, agentId, reason),
    });
  }

  #createLaunchCustody(): AgentLaunchCustody {
    return new AgentLaunchCustody({
      messageAttention: this.#messageAttention,
      deliveryGate: this.#deliveryGate,
      inputDrain: this.#inputDrain,
      agentProcessManager: this.#agentProcessManager,
      currentActivityLaunches: this.#currentActivityLaunches,
      introducedAgents: this.#introducedAgents,
      releaseHeldAppItems: (agentId) => this.#inboxCoordinator.releaseHeldAppItems(agentId),
      releaseFallbackNotices: (agentId) => this.#inboxCoordinator.releaseFallbackNotices(agentId),
    });
  }

  #createStopCoordinator(): AgentStopCoordinator {
    return new AgentStopCoordinator({
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
      lifecycle: this.#lifecycle,
      offlineResidency: this.#offlineResidency,
      sendAgentStatus: this.#sendAgentStatus,
      publishStopped: (agentId, launch) =>
        this.#activityPublisher.publish(agentId, launch, this.#drafts.stopped(agentId)),
    });
  }

  #createLaunchCoordinator(): AgentLaunchCoordinator {
    return new AgentLaunchCoordinator({
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
      credentialHolds: this.#credentialHolds,
      lifecycle: this.#lifecycle,
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
      reconcileIdleTurn: this.#turn.reconcileIdleTurn,
      activity: (agentId, detailKind, level, detail, extra) =>
        this.#activity(agentId, detailKind, level, detail, extra),
      narrateUnavailable: (agentId, launch, activity) =>
        this.#turn.narrateUnavailable(agentId, launch, activity),
      disposeLaunchObservations: this.#disposeLaunchObservations,
      revokeLocalLaunch: this.#revokeLocalLaunch,
      revokeAgentApiKey: (agentId, apiKey, scope) =>
        this.#revokeAgentApiKey(agentId, apiKey, scope),
      launchFailureActivity: (agentId, provider, error) =>
        launchFailureActivity(agentId, provider, error, this.#drafts),
      appInbox: this.#inboxCoordinator,
      ...launchInputPorts(this.#memoryHooks),
      relaunchResumed: (agentId, restart, request) => {
        void this.#wakeAgent(agentId, restart, request).catch(() => {});
      },
    });
  }

  #createStartup(): RuntimeStartup {
    return new RuntimeStartup({
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
        ...controlPublications(() => this.#controlIntentPorts()),
        applyAgentConfigSync: (sync) => this.handleAgentConfig(sync),
        interruptAgent: (intent) => this.handleAgentTurnInterrupt(intent),
        probeAgent: (probe) => this.handleAgentActivityProbe(probe),
        purgeAgentInbox: (purge) => this.handleAgentInboxPurge(purge),
        resetWorkspace: (request) => this.handleAgentWorkspaceReset(request),
        deliverMessage: (message) => this.handleAgentMessage(message),
        stopRuntime: () => this.stop(),
        connectionRefused: (reason) => this.lifecycle.connectionRefused?.(reason),
        receiveReminderDue: (due) => this.#services.reminders.receive(due),
        applyAppConfigSync: (sync) => this.#services.appConfigs.apply(sync),
        applyAgentServerFeatures: (sync) => this.#sync.applyServerFeatures(sync),
        acceptAppRegistrationNotice: (notice) =>
          acceptAppRegistrationNotice(notice, {
            isRunning: (agentId) => this.#readyRunningAgentIds().includes(agentId),
            mint: (agentId, item) => this.mintAppItem(agentId, item),
          }).then(() => {}),
        migration: migrationRoute(this.#services.migrations),
      },
      agentControl: this.#agentControl,
      agentSessions: this.#agentSessions,
      configApply: this.#configApply,
      readyRunningAgentIds: () => this.#readyRunningAgentIds(),
      operatingSystem: this.#operatingSystem,
      upgradeResults: this.#services.upgradeResults,
      runtimeAuth: this.#runtimeAuth,
      credentialHolds: this.#credentialHolds,
      runtimeAuthFactory: this.runtimeAuthFactory,
      codeAgentInventory: this.#codeAgentInventory,
      scanUsage: (provider) => this.scanUsage(provider),
      consumeResetCredit: (provider, key) => this.consumeResetCredit(provider, key),
      workspaceQueries: this.#workspaceQueries,
      stateDirectory: this.stateDirectory,
      contextView: this.#contextViewService,
      sideAsk: this,
      agentApiKey: (agentId) => this.agentApiKeys.get(agentId),
      resolveProviderSource: (agentId, entry) =>
        resolveContextViewProviderSource(this, agentId, entry),
      deleteWorkspace: (request) => this.#deleteWorkspace(this.#connection, request),
      lifecycle: startupLifecycle(
        this.lifecycle,
        this.#services.upgradeResults,
        this.#connection.workspaceId,
      ),
      reminders: this.#services.reminders,
      resyncAppConfigs: () => this.#resyncAppConfigs(),
      activityPublisher: this.#activityPublisher,
      sweeps: this.#sweeps,
      machineStatus: this.#machineStatus,
      procJobs: this.#services.procJobs,
    });
  }

  #createAgentOperations(): AgentOperations {
    return new AgentOperations({
      connection: this.#connection,
      transport: () => this.#transport,
      assertRunning: () => this.#assertRunning(),
      assertOwnIntent: this.#assertOwnIntent,
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
      interruptIfBusy: (agentId, launch) => this.#turn.interruptIfBusy(agentId, launch),
      disposeLaunchObservations: this.#disposeLaunchObservations,
      revokeLocalLaunch: (agentId) =>
        revokeLocalLaunch(this.#agentContexts, this.#agentProxyTokens, this.#agentProxy, agentId),
      stopCoordinator: this.#stopCoordinator,
      messageOperations: this.#messageOperations,
    });
  }

  #createShutdown(): RuntimeStop {
    return new RuntimeStop({
      startup: this.#startup,
      sweeps: this.#sweeps,
      configApply: this.#configApply,
      machineStatus: this.#machineStatus,
      activityPublisher: this.#activityPublisher,
      currentActivityLaunches: this.#currentActivityLaunches,
      phaseBookkeeping: this.#phaseBookkeeping,
      runtimeErrorHold: this.#runtimeErrorHold,
      upgradeResults: this.#services.upgradeResults,
      usageReport: this.#usageReport,
      fastModeWarned: this.#fastModeWarned,
      inputDrain: this.#inputDrain,
      agentLaunches: this.#agentLaunches,
      agentProcessManager: this.#agentProcessManager,
      stops: this.#stopState,
      launchCoordinator: this.#launchCoordinator,
      messageAttention: this.#messageAttention,
      mentionDeliveries: this.#mentionDeliveries,
      reminders: this.#services.reminders,
      systemCleaner: this.systemCleaner,
      migrations: this.#services.migrations,
      procJobs: this.#services.procJobs,
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

  #authorizedAgent = (context: string, agentApiKey: string | undefined): string => {
    this.#assertRunning();
    const agentId = agentIdForContext(this.#agentContexts, context);
    if (!isAgentApiKey(agentApiKey))
      throw new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING");
    return agentId;
  };
  authorizedAgent(context: string, agentApiKey: string | undefined): string {
    return this.#authorizedAgent(context, agentApiKey);
  }
  async scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse> {
    return scanUsage(
      {
        assertRunning: () => this.#assertRunning(),
        workspaceRoot: this.#connection.workspaceRoot,
        createProvider: (provider) => this.#createProvider(provider),
        observedUsage: (provider) => currentObservedUsage(this.#observedUsage, provider),
      },
      provider,
    );
  }

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
  #replaceTransport = async (): Promise<unknown> =>
    replaceTransport(
      withMutableTransport(
        () => this.#transport,
        (value) => {
          this.#transport = value;
        },
        {
          transportFactory: this.#transportFactory,
          connection: this.#connection,
        },
      ),
    );
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
      (agentId) => this.#services.procJobs.forgetAgent(agentId, "agent_deleted"),
    );
  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    sessionId?: string,
    requestId?: string,
    recovery?: AgentRecoveryContext,
    previousLaunchId?: string,
    sessionMode?: SessionMode,
    control?: {
      controlEpoch?: number;
      launchId: string;
    },
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
  ): Promise<AgentRuntime> => {
    if (this.#agentControl.isStopped(agentId))
      return Promise.reject(new Error("Agent is stopped; a server Start is required"));
    return startAgent(
      {
        assertRunning: () => this.#assertRunning(),
        assertAgentNotStopping: (id) => this.#assertAgentNotStopping(id),
        migrations: this.#services.migrations,
        requestAppConfigSnapshot: (id) => requestAppConfigSnapshot(this.#appInboxSyncPorts(), id),
        inputDrain: this.#inputDrain,
        introducedAgents: this.#introducedAgents,
        agentLaunches: this.#agentLaunches,
        agentProcessManager: this.#agentProcessManager,
        runnerHold: this.#runnerHold,
        messageAttention: this.#messageAttention,
        wakeLaunchFailures: this.#wakeLaunchFailures,
        launchCoordinator: this.#launchCoordinator,
        exitedDelivery: this.#exitedDelivery,
        releaseSurvivingHolds: (id) => this.#turn.releaseSurvivingHolds(id),
        sessions: this.#stopState,
        configApply: this.#configApply,
      },
      agentId,
      config,
      recovery,
      request,
    );
  };

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
      appConfigs: this.#services.appConfigs,
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
      reminders: this.#services.reminders,
      inboxCoordinator: this.#inboxCoordinator,
    };
  }
  #env = () => runtimeEnvelope(this.#connection);

  #scheduleStartupFailure = (agentId: string, launch: ActivityLaunch): void =>
    scheduleStartupFailure(this.#startupFailurePorts(), agentId, launch);
  #startupFailurePorts() {
    return {
      stopping: this.#stopping,
      stops: this.#stopState,
      inputDrain: this.#inputDrain,
      currentActivityLaunches: this.#currentActivityLaunches,
      interruptIfBusy: (id: string, current: ActivityLaunch | undefined) =>
        this.#turn.interruptIfBusy(id, current),
      activityPublisher: this.#activityPublisher,
      disposeLaunchObservations: this.#disposeLaunchObservations,
      offlineResidency: this.#offlineResidency,
      stopCoordinator: this.#stopCoordinator,
      drafts: this.#drafts,
      agentControl: this.#agentControl,
    };
  }

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

  #observeRuntimeEvent = launchEventObserver(() => ({
    currentLaunch: (id) => this.#currentActivityLaunches.get(id),
    observation: this.#observationPorts,
  }));
  #assertOwnIntent = (intent: Parameters<typeof assertOwnIntent>[0]) =>
    assertOwnIntent(intent, this.#connection.workspaceId, this.#connection.computerId);
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
      stopAgentJobs: (agentId) => this.stopAgentJobs(agentId),
    });
  }
  async handleAgentWorkspaceReset(request: AgentWorkspaceResetRequest): Promise<void> {
    return handleAgentWorkspaceReset(this.#controlIntentPorts(), request);
  }
  async handleAgentStop(intent: AgentStopIntent): Promise<void> {
    return handleAgentStop(this.#controlIntentPorts(), intent);
  }

  async handleAgentConfig(sync: AgentConfigSync): Promise<void> {
    this.#assertOwnIntent(sync);
    await this.#configApply.accept(sync);
  }
  async handleAgentTurnInterrupt(intent: AgentTurnInterruptIntent): Promise<void> {
    return handleAgentTurnInterrupt(
      {
        assertOwnIntent: this.#assertOwnIntent,
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

  async handleAgentActivityProbe(probe: AgentActivityProbe): Promise<void> {
    return this.#agentOperations.handleActivityProbe(probe);
  }
  async handleAgentMessage(message: AgentMessageDelivery): Promise<void> {
    return handleAgentMessage(this.#messageDeliveryPorts(), message);
  }

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
  currentActivityLaunch(agentId: string) {
    return this.#currentActivityLaunches.get(agentId);
  }
  stopping(agentId: string): boolean {
    return this.#stopState.isStopping(agentId) || this.#agentProcessManager.isStopping(agentId);
  }
  reported(agentId: string) {
    return this.#reported.last(agentId);
  }
  onRuntimeEnd(listener: (agentId: string) => void) {
    return this.#agentProcessManager.onRuntimeEnd(listener);
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

  handleAgentInboxPurge(purge: AgentInboxPurge): void {
    return this.#agentOperations.handleInboxPurge(purge);
  }
  stopAgent(agentId: string): Promise<void> {
    this.#configApply.stopped(agentId);
    return this.#agentOperations.stopAgent(agentId);
  }
  stopAgentJobs(agentId: string): Promise<void> {
    return this.#services.procJobs.stopAllForAgent(agentId, "owner_stop").then(() => {});
  }

  #revokeLocalLaunch = (agentId: string, context?: string, proxyToken?: string) =>
    revokeLocalLaunch(
      this.#agentContexts,
      this.#agentProxyTokens,
      this.#agentProxy,
      agentId,
      context,
      proxyToken,
    );
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
    activity: this.#activity,
    isWorking: this.#turn.isWorking,
  });

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
      this.#services.procJobs,
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
  get version() {
    return this.localQueries.version.bind(this.localQueries);
  }
  readonly agentMemory = new LocalMemoryRuntime(
    (context, key) => this.#authorizedAgent(context, key),
    () => this.#connection,
    (id) => this.systemCleaner.onMemoryWrite(id),
  ).execute;
  async agentTask(context: string, command: TaskCommand, agentApiKey: string): Promise<TaskResult> {
    return agentTask(this.#agentApiRemindersPorts(), context, command, agentApiKey);
  }
  async mintAppItem(agentId: string, input: MintAppItem) {
    return mintAppItem(this.#agentApiRemindersPorts(), agentId, input);
  }
  async reminder(context: string, request: LocalReminderRequest, agentApiKey: string) {
    return reminder(this.#agentApiRemindersPorts(), context, request, agentApiKey);
  }
  #resyncAppConfigs(): void {
    resyncAppConfigs(this.#appInboxSyncPorts());
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
    return context;
  }
  #runnerHoldCell() {
    return liveHoldCell(
      () => this.#runnerHold,
      (value) => {
        this.#runnerHold = value;
      },
    );
  }

  holdRunners(reason: RunnerHoldReason): BusyAgentReport[] {
    return holdRunners(this.#runnerHoldCell(), reason, this.#activityPublisher);
  }

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

  busyAgents(): BusyAgentReport[] {
    return this.#activityPublisher.busyAgents();
  }

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
