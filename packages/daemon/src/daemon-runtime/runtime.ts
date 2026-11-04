import { createRuntimeAuthAdapter } from "#src/code-agent/registry";
import { AgentStopRegistry } from "./agent-stop-registry";
import type { RuntimeAuthAdapter, RuntimeAuthProvider } from "@lrm/coforge-anvil";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type UsageSnapshot,
} from "@lrm/coforge-anvil";
import { OperatingSystemInfo } from "#src/platform/operating-system";
import { FileConversationSessionStore } from "#src/persistence/conversation-session-store";
import { escapePathIdentity } from "#src/persistence/path-scope";
import { AgentInputDrain } from "./agent-input-drain";
import { rebindAgent } from "./agent-rebind";
import { AgentLaunchCustody } from "./agent-launch-custody";
import { AgentContexts } from "./agent-contexts";
import { PhaseBookkeeping } from "./phase-bookkeeping";
import { type RuntimeEventObservationPorts } from "./runtime-event-observation";
import {
  canonicalAgentMessageTarget,
  observeLaunchEvent,
  handleAgentStart,
  handleAgentStop,
  handleAgentTurnInterrupt,
  handleAgentWorkspaceReset,
  scanUsage,
  type AgentControlIntentPorts,
} from "./runtime-agent-flows";
import type { AgentProxy, LaunchRequest, SessionMode } from "./runtime-launch-types";
import {
  AgentProcessManager,
  type CodeAgentProviderFactory,
  type AgentRuntime,
} from "#src/agent-runtime/agent-process-manager";
import { activityDraft } from "./activity-draft";
import type { AgentRecoveryContext } from "./runtime-launch-intent";
import { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import { createAgentDesktopHolds } from "#src/agent-runtime/agent-desktop";
export type DaemonConfig = {
  workspaceId: string;
  computerId: string;
  workspaceRoot: string;
  serverHttpUrl?: string;
};
/** @deprecated wire-facing callers should use DaemonConfig internally. */
export type WorkspaceConfig = DaemonConfig;
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
  runningMentionIdentity,
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
  type DaemonConnectRejectionReason,
  type RunnerHoldReason,
  AGENT_MESSAGE_REJECT_METHOD,
  MENTION_DELIVERY_TERMINAL_CODES,
  type AgentActivity,
  type AgentMessageResponse,
  type AgentStartIntent,
  type AgentSessionReport,
  type AgentStopIntent,
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
import { assembleAgentRequests } from "./agent-request-forwarder";
import { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import { AgentStopCoordinator } from "./agent-stop-coordinator";
import { AgentLaunchCoordinator } from "./agent-launch-coordinator";
import { startAgent } from "./agent-start-coordinator";
import { deleteWorkspace, requestUpgrade } from "./runtime-lifecycle-operations";
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
import { stalledRecoverySweep } from "./stalled-recovery-sweep";
import { CatalogFreshnessSweep } from "./catalog-freshness-sweep";
import { rememberUsage } from "./usage-memory";
import { runtimeMachineStatus } from "./machine-status-reporter";
import { agentActivityDrafts } from "./agent-activity-drafts";
import { sendAgentStatus, type AgentStatusReportPorts } from "./agent-status-report";
import { agentIdForContext, contextFor } from "./agent-context";
import { cleanupUnconfirmed, buildLaunchFailureActivity } from "./agent-failure-presentation";
import { RuntimeRelease, wakeRequest, type WakeRestart } from "./runtime-release";
import { beginWakeLaunch } from "./wake-launch";
import { AgentFeatureSync } from "./agent-feature-sync";
import { WakeRecycle } from "./wake-recycle";
import { AgentMessageOperations } from "./agent-message-operations";
import { AgentRequestForwarder } from "./agent-request-forwarder";
import { AgentDeliveryQueue } from "./agent-delivery-queue";
import { ReplyIntentPublisher } from "./reply-intent-publisher";
import {
  AgentActivityPublisher,
  type ActivityDraft,
  type BusyAgentReport,
} from "./agent-activity-publisher";
import { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import type { ActivityLaunch } from "./activity-launch";
import { AgentOfflineResidency } from "./agent-offline-residency";
import { AgentExitedDelivery } from "./agent-exited-delivery";
import { AgentUsageReport } from "./agent-usage-report";
import {
  isTrackedMention,
  MentionDeliveryTracker,
  type RunningMentionIdentity,
} from "./mention-delivery-tracker";
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
import { composeMessages, agentDeliveryRejection } from "./message-composition";
import { composeRuntimeServices } from "./runtime-services-composition";
import { AgentOperations } from "./agent-operations";
import { composeAgentControl } from "./agent-control-composition";
import {
  UpgradeResultReporter,
  type RecoveredUpgradeResult,
  type UpgradeOperationsReading,
} from "./upgrade-result-reporter";
import type { UnrefTimerSchedule } from "./unref-timer";
import type { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import type { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import { logAgentOperationFailure, logComputerUpdateNoticeFailure } from "./agent-failure-logs";
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
  /** The launch and native session last reported to the cloud per Agent: the identity a tracked
   * mention's envelope must name, while that launch is still the running one. */
  readonly #reportedSessions = new Map<string, RunningMentionIdentity>();
  /** Busy-gated delivery holding for providers with no safe busy path. */
  readonly #deliveryQueue = new AgentDeliveryQueue();
  /** Launch failures of message-triggered wakes, per Agent: while one owes a cooldown, a delivery
   * does not launch the Agent again. No attempt cap. The short cooldown stops growing at its
   * ceiling; a quota failure that names a recovery time waits until then. */
  readonly #wakeLaunchFailures = new LaunchFailureBackoff();
  readonly #exitedDelivery = new AgentExitedDelivery({
    hasRuntimeErrorHold: (agentId) => this.#deliveryQueue.explicitHold(agentId) !== undefined,
    holdRuntimeErrorDelivery: (message) => this.#messageAttention.receive(message),
    hasConsumed: (message) => this.#messageAttention.hasConsumed(message),
    logConsumed: (message) => this.#messageAttention.logDecision(message, "consumed"),
    acknowledge: (message) => this.#messageAttention.acknowledge(message),
    acknowledgeCustody: (message) => this.#launchCustody.acknowledge(message),
    restartConfig: (agentId) => this.#agentProcessManager.restartConfig(agentId),
    startPending: (agentId) => this.#agentControl.startPending(agentId),
    hasQueued: (agentId) => this.#deliveryQueue.hasQueued(agentId),
    queueForNextLaunch: (agentId, m) => this.#deliveryQueue.enqueue(agentId, m),
    wakeBlockedUntil: (agentId) =>
      this.#wakeLaunchFailures.isBlocked(agentId)
        ? this.#wakeLaunchFailures.blockedUntil(agentId)
        : undefined,
    enqueueInputDelivery: (agentId, message) =>
      this.#launchCustody.enqueueDelivery(agentId, message),
    wakeAgent: (agentId, restart) => this.#wakeAgent(agentId, restart),
    offline: {
      has: (agentId) => this.#offlineResidency.has(agentId),
      restate: (agentId) => this.#offlineResidency.restate(agentId),
    },
    queuedInputDeliveries: (agentId) =>
      this.#inputDrain
        .get(agentId)
        ?.items.flatMap((item) => (item.kind === "delivery" ? [item.message] : [])) ?? [],
    drainInputDeliveries: (agentId) => {
      const queue = this.#inputDrain.get(agentId);
      const kept: AgentMessageDelivery[] = [];
      if (queue)
        queue.items = queue.items.filter((item) => {
          if (item.kind !== "delivery") return true;
          item.completion.resolve();
          kept.push(item.message);
          return false;
        });
      return kept;
    },
    closeAgentInputQueue: (agentId, error) => this.#inputDrain.close(agentId, error),
    dropMentionAsUnknown: (message) =>
      this.#mentionDeliveries.drop(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN),
    sendAgentStatus: (agentId, status) => this.#sendAgentStatus(agentId, status),
    sendAgentDeliveryRejection: (message, reason) =>
      this.#transport.sendAgentDeliveryRejection?.(agentDeliveryRejection(message, reason)) ??
      Promise.resolve(),
    hasSession: (agentId) => this.#agentProcessManager.session(agentId) !== undefined,
    redeliver: (message) =>
      void this.handleAgentMessage(message).catch((error) =>
        logAgentOperationFailure(this.#connection.computerId, "message_delivery", message, error),
      ),
  });
  /** Agents whose in-flight launch is a message wake, which presents what waits as one notice. */
  readonly #wakeLaunches = new Set<string>();
  readonly #sync = new AgentFeatureSync({
    live: (agentId) => this.#runtimeRelease.canRestartForFreshConfig(agentId),
    keep: (m) => this.#exitedDelivery.keepForNextLaunch(m.agentId, m),
    restart: (agentId) => this.#runtimeRelease.restartForFreshConfig(agentId),
  });
  readonly #runtimeRelease = new RuntimeRelease<ActivityLaunch>({
    launch: (agentId) => this.#currentActivityLaunches.get(agentId),
    runtime: (agentId) => this.#agentProcessManager.runtime(agentId),
    restartConfig: (agentId) => this.#agentProcessManager.restartConfig(agentId),
    lastBusy: (agentId) => this.#activityPublisher.lastBusy(agentId),
    queuedForMs: (agentId) => this.#deliveryQueue.queuedForMs(agentId),
    resumable: (agentId) => this.#runningMentionIdentity(agentId) !== undefined,
    sessionId: (agentId) => this.#stopState.sessionId(agentId),
    isStopping: (agentId) => this.#stopState.stopping(agentId),
    daemonIdleFacts: (agentId) => {
      const queue = this.#inputDrain.get(agentId);
      return {
        working: this.#isWorking(agentId),
        deliveriesQueued: this.#deliveryQueue.hasQueued(agentId),
        inputsQueued: queue !== undefined && (queue.items.length > 0 || queue.drain !== undefined),
        launching: this.#agentLaunches.has(agentId),
        stopping:
          this.#stopState.isStopping(agentId) || this.#agentProcessManager.isStopping(agentId),
        runnerHold: this.#runnerHold !== undefined,
        migrating: this.#migrations?.holds(agentId) === true,
      };
    },
    hasParkedWork: (agentId) =>
      this.#deliveryQueue.hasQueued(agentId) || this.#deliveryQueue.hasHeldAppItems(agentId),
    flushParked: (agentId) => this.#releaseSurvivingHolds(agentId),
    wake: (agentId, restart) => this.#wakeAgent(agentId, restart),
    publish: (agentId, launch, ...draft) =>
      this.#activityPublisher.publish(agentId, launch, this.#activity(agentId, ...draft)),
    handBackMentions: (agentId) => this.#mentionDeliveries.handBackForRelaunch(agentId),
    release: (agentId, timeoutMs) => this.#agentProcessManager.release(agentId, timeoutMs),
  });
  /** Stops cold, idle, large-context runtimes; the next launch decides resume or fresh session. */
  readonly #coldIdleSweep = new ColdIdleSweep({
    agentIds: () => this.#agentProcessManager.runningAgentIds(),
    agent: (agentId) => this.#runtimeRelease.coldIdleAgent(agentId),
    provider: (provider) => this.#createProvider(provider),
    stop: (stop) => this.#runtimeRelease.stopColdIdle(stop),
  });
  readonly #stalledRecoverySweep = stalledRecoverySweep({
    agentIds: () => this.#agentProcessManager.runningAgentIds(),
    hasQueuedDeliveries: (agentId) => this.#deliveryQueue.hasQueued(agentId),
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
    hasQueuedDeliveries: (agentId) => this.#deliveryQueue.hasQueued(agentId),
  });
  /** Per-Agent delivery hold after retryable runtime errors: backoff, fingerprint fence, and the
   * backoff's release timer. */
  readonly #runtimeErrorHold = new RuntimeErrorDeliveryHold({
    deliveryQueue: this.#deliveryQueue,
    flush: (agentId, held) => this.#flushHeldDeliveries(agentId, held),
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
  readonly #agentProxyTokens = new Map<string, string>();
  readonly #agentApiKeys = new Map<string, string>();
  /** Agents launched with the weekly-report-collect skill pack. */
  readonly #collectSkillAgents = new Set<string>();
  readonly #agentLaunches = new Map<string, Promise<AgentRuntime>>();
  readonly #inputDrain = new AgentInputDrain({
    runnerHeld: () => this.#runnerHold !== undefined,
    sessionFor: (agentId) => this.#agentProcessManager.session(agentId),
    launchFor: (agentId) => this.#currentActivityLaunches.get(agentId),
    hasQueuedDeliveries: (agentId) => this.#deliveryQueue.hasQueued(agentId),
    isLaunching: (agentId) => this.#agentLaunches.has(agentId),
    isStopping: (agentId) => this.#stopState.stopping(agentId),
    deliverMessage: (_agentId, message) =>
      isTrackedMention(message)
        ? this.#mentionDeliveries.deliver(message)
        : this.#messageAttention.receive(message),
    runStartup: async (agentId, session, launch, text) => {
      this.#launchCustody.noteTurnStarted(agentId);
      await launch.startup?.run(session.sendMessage(text));
    },
    runPrompt: (agentId, text, introduction) =>
      this.#launchCustody.runPromptTurn(agentId, text, introduction),
    recoverAttention: (agentId, context) => this.#launchCustody.recover(agentId, context),
    abandonLaunch: (agentId, error) => this.#abandonLaunch(agentId, error),
    publishStartupError: (agentId, launch, message) =>
      this.#activityPublisher.publish(agentId, launch, this.#drafts.runtimeError(agentId, message)),
    forgetIntroduced: (agentId) => this.#introducedAgents.delete(agentId),
    dropMention: (message) =>
      this.#mentionDeliveries.drop(message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED),
  });
  /** Delivery admission, launch-boundary recovery, and turn-open bookkeeping. */
  readonly #launchCustody: AgentLaunchCustody;
  /** Agents whose current process was already handed its introduction turn: one per process,
   * however many Starts carry `introductionPrompt`. Set only when a live session takes the turn;
   * a Start also queues none while one waits unsent, so one a crashed process left queued goes to
   * its relaunch. Forgotten when the Agent's input queue closes or its process exits, so a later
   * launch introduces again while the server still asks. */
  readonly #introducedAgents = new Set<string>();
  readonly #desktops = createAgentDesktopHolds();
  /** Which Agents are stopping and which Session each launch reported. */
  readonly #stopState = new AgentStopRegistry();
  readonly #currentActivityLaunches = new Map<string, ActivityLaunch>();
  readonly #agentStatusSequences = new Map<string, number>();
  /** The per-Agent offline record a runtime error leaves (`agent-offline-residency.ts`). */
  readonly #offlineResidency = new AgentOfflineResidency({
    endHoldForNextLaunch: (agentId) => this.#deliveryQueue.endHoldForNextLaunch(agentId),
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
    sendAgentStatus: (agentId, status) => this.#sendAgentStatus(agentId, status),
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
  readonly #usageReport = new AgentUsageReport({
    sessionId: (agentId) => this.#stopState.sessionId(agentId),
    envelope: () => this.#env(),
    daemonInstanceId: () => this.#runtimeInstanceId,
    recordClientSeq: (agentId, clientSeq) =>
      this.#agentProcessManager.recordClientSeq(agentId, clientSeq),
    sendContextUsage: (message) => this.#transport.sendAgentContextUsage?.(message),
    sendServiceTier: (message) => this.#transport.sendAgentServiceTier?.(message),
  });
  /** Agents whose launch has already been warned that Fast mode was requested but is not applied.
   * One warning per launch, forgotten with the usage report. */
  readonly #fastModeWarned = new Set<string>();
  readonly #agentProxy?: AgentProxy;
  readonly #activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  readonly #replyIntents = new ReplyIntentPublisher<ActivityLaunch>({
    currentLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
    transport: () => this.#transport,
    workspaceId: () => this.#connection.workspaceId,
    active: () => this.#startup.started,
  });
  /** Runner-hold reason while this runtime is refusing new turns; undefined when not held.
   * Deliberately in-memory only, so a restarted daemon is never born held. */
  #runnerHold: RunnerHold | undefined;
  /** Each phase's open state and stale watchdog — see `phase-bookkeeping.ts`. */
  readonly #contexts = new AgentContexts((agentId) => this.#consumedSeqs.stateDb(agentId));
  readonly #phaseBookkeeping = new PhaseBookkeeping({
    contexts: this.#contexts,
    launchFor: (agentId) => this.#currentActivityLaunches.get(agentId),
    publish: (agentId, launch, draft) => this.#activityPublisher.publish(agentId, launch, draft),
    activityDraft: (agentId, detailKind, detail) =>
      this.#activity(agentId, detailKind, "info", detail),
  });
  /** Provider-event observation: the runtime's collaborators by reference, its helpers as calls.
   * Assigned at the constructor's end — every collaborator it names exists by then. */
  readonly #observationPorts: RuntimeEventObservationPorts;
  readonly #codeAgentInventory: CodeAgentInventorySync;
  readonly #runtimeAuth: RuntimeAuthReporter;
  readonly #upgradeResults: UpgradeResultReporter;
  /** The Workspace connection's open sequence and the state it installs; assigned at the
   * constructor's end, once every collaborator it names exists. */
  readonly #startup: RuntimeStartup;
  /** The closing flow; assigned at the constructor's end like `#startup`. */
  readonly #shutdown: RuntimeStop;
  /** The cloud-facing Agent operations; assigned at the constructor's end. */
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
    private readonly stateDirectory = ".coforge-daemon-state",
    private readonly lifecycle: {
      requestRestart?(requestId: string): Promise<void>;
      requestUpgrade?(requestId: string, expectedVersion?: string): Promise<void>;
      recoveredRestartRequestIds?: string[];
      recoveredUpgradeRequestIds?: string[];
      /** Terminal upgrade operations this machine still owes the server a report for, as known
       * at construction time. */
      recoveredUpgradeResults?: RecoveredUpgradeResult[];
      /**
       * Re-reads the upgrade operations in durable local config, which the Coordinator rewrites
       * whenever it records, settles or acknowledges one; `UpgradeResultReporter` polls it while
       * one is pending. Absent: `recoveredUpgradeResults` is all there is.
       */
      readUpgradeOperations?(): Promise<UpgradeOperationsReading>;
      /** The reporter's poll and retry timer; absent, an unref'd `setTimeout`. */
      upgradeResultSchedule?: UnrefTimerSchedule;
      /** Called once the server has accepted a reported result. */
      acknowledgeUpgradeResult?(requestId: string): Promise<void>;
      /** The cloud refused this Workspace's running connection for good. Called after every
       * Agent was stopped; the Workspace process then parks itself. */
      connectionRefused?(reason: DaemonConnectRejectionReason): void;
      /** Whether an installer upgrade is in flight, read when a stop names its reason. Absent
       * means no upgrade is known to be in flight. */
      installerJournalExists?(): boolean;
    } = {},
    private readonly computerVersion?: string,
    systemCleaner: Pick<
      SystemCleanerOptions,
      "clock" | "measureMemoryFile" | "measureDiskSpace"
    > = {},
    private readonly runtimeAuthFactory: (
      provider: RuntimeAuthProvider,
    ) => RuntimeAuthAdapter = createRuntimeAuthAdapter,
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
      reconcileIdleTurn: (agentId, launch) => this.#reconcileIdleTurn(agentId, launch),
    });
    this.#connection = connection;
    this.#drafts = agentActivityDrafts(connection.workspaceId);
    this.#createProvider = createProvider;
    this.#agentProcessManager = new AgentProcessManager(
      createProvider,
      undefined,
      (agentId) =>
        new FileConversationSessionStore(
          `${stateDirectory}/conversation-sessions/${escapePathIdentity(connection.workspaceId)}/${escapePathIdentity(agentId)}.json`,
        ),
    );
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
      deliveryQueue: this.#deliveryQueue,
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
      reconcileIdleTurn: (agentId, launch) => this.#reconcileIdleTurn(agentId, launch),
      startAgent: (agentId, config, sessionId) =>
        this.#startAgent(agentId, config, undefined, { sessionId }),
      assertRunning: () => this.#assertRunning(),
      agentIdForContext: (context) => agentIdForContext(this.#agentContexts, context),
      runningMentionIdentity: (agentId) => this.#runningMentionIdentity(agentId),
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
      forgetSessionReference: (agentId) => this.#stopState.forgetSession(agentId),
      startSettled: (agentId) => this.#exitedDelivery.releaseStartBuffer(agentId),
      sendSessionInvalidate: (message) => this.#transport.sendSessionInvalidate?.(message),
      reportSession: (report) => this.#reportAgentSession(report),
      sendControlResult: async (result) => {
        await this.#transport.sendAgentControlResult?.(result);
      },
    });
    this.#agentSessions = control.agentSessions;
    this.#agentControl = control.agentControl;
    this.#observationPorts = {
      activityPublisher: this.#activityPublisher,
      deliveryQueue: this.#deliveryQueue,
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
      collectSkillAgents: this.#collectSkillAgents,
      fastModeWarned: this.#fastModeWarned,
      isWorking: (agentId) => this.#isWorking(agentId),
      activityDraft: (agentId, kind, level, detail, extra) =>
        this.#activity(agentId, kind, level, detail, extra),
      runtimeErrorActivity: (agentId, message) => this.#drafts.runtimeError(agentId, message),
      interruptedActivity: (agentId) => this.#drafts.interrupted(agentId),
      showQuietTurn: (agentId, launch, publish) => this.#showQuietTurn(agentId, launch, publish),
      reconcileIdleTurn: (agentId, launch) => this.#reconcileIdleTurn(agentId, launch),
      rememberUsage: (snapshot) => rememberUsage(this.#observedUsage, snapshot),
      releaseTurnEndHolds: (agentId) => this.#releaseTurnEndHolds(agentId),
      drainAppInboxNotices: (agentId) => this.#inboxCoordinator.drainAppInboxNotices(agentId),
      failCollectorRunningSlots: (agentId, reason) =>
        this.#failCollectorRunningSlots(agentId, reason),
    };
    this.#launchCustody = new AgentLaunchCustody({
      messageAttention: this.#messageAttention,
      deliveryQueue: this.#deliveryQueue,
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
      agentApiKeys: this.#agentApiKeys,
      revokeAgentApiKey: (agentId, apiKey) => this.#revokeAgentApiKey(agentId, apiKey),
      messageAttention: this.#messageAttention,
      deliveryQueue: this.#deliveryQueue,
      runtimeErrorHold: this.#runtimeErrorHold,
      offlineResidency: this.#offlineResidency,
      sendAgentStatus: (agentId, status) => this.#sendAgentStatus(agentId, status),
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
      deliveryQueue: this.#deliveryQueue,
      usageReport: this.#usageReport,
      fastModeWarned: this.#fastModeWarned,
      sync: this.#sync,
      agentApiKeys: this.#agentApiKeys,
      agentProxy: this.#agentProxy,
      agentProxyTokens: this.#agentProxyTokens,
      desktops: this.#desktops,
      wakeRecycle: this.#wakeRecycle,
      stops: this.#stopState,
      collectSkillAgents: this.#collectSkillAgents,
      introducedAgents: this.#introducedAgents,
      messageAttention: this.#messageAttention,
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
      sendAgentStatus: (agentId, status) => this.#sendAgentStatus(agentId, status),
      scheduleStartupFailure: (agentId, launch) => this.#scheduleStartupFailure(agentId, launch),
      observeRuntimeEvent: (agentId, launch, config, runtime, managed, event) =>
        this.#observeRuntimeEvent(agentId, launch, config, runtime, managed, event),
      reconcileIdleTurn: (agentId, launch) => this.#reconcileIdleTurn(agentId, launch),
      activity: (agentId, detailKind, level, detail, extra) =>
        this.#activity(agentId, detailKind, level, detail, extra),
      narrateUnavailable: (agentId, launch, activity) =>
        this.#narrateUnavailable(agentId, launch, activity),
      disposeLaunchObservations: (agentId) => this.#disposeLaunchObservations(agentId),
      revokeLocalLaunch: (agentId, context, proxyToken) =>
        revokeLocalLaunch(
          this.#agentContexts,
          this.#agentProxyTokens,
          this.#agentProxy,
          agentId,
          context,
          proxyToken,
        ),
      revokeAgentApiKey: (agentId, apiKey) => this.#revokeAgentApiKey(agentId, apiKey),
      launchFailureActivity: (agentId, provider, error) =>
        this.#launchFailureActivity(agentId, provider, error),
      drainAppInboxNotices: (agentId) => this.#inboxCoordinator.drainAppInboxNotices(agentId),
    });
    this.#startup = new RuntimeStartup({
      transport: () => this.#transport,
      replaceTransport: () => this.#replaceTransport(),
      credentials: this.#credentials,
      runtimeInstanceId: this.#runtimeInstanceId,
      startedAtMs: this.#startedAt,
      computerVersion: this.computerVersion,
      isStopping: () => this.#stopping,
      publications: {
        startAgent: (intent) => this.handleAgentStart(intent),
        stopAgent: (intent) => this.handleAgentStop(intent),
        interruptAgent: (intent) => this.handleAgentTurnInterrupt(intent),
        probeAgent: (probe) => this.handleAgentActivityProbe(probe),
        purgeAgentInbox: (purge) => this.handleAgentInboxPurge(purge),
        resetWorkspace: (request) => this.handleAgentWorkspaceReset(request),
        deliverMessage: (message) => this.handleAgentMessage(message),
        stopRuntime: () => this.stop(),
        connectionRefused: (reason) => this.lifecycle.connectionRefused?.(reason),
        applyReminderSync: (sync) => this.#reminders.apply(sync),
        applyAppConfigSync: (sync) => this.#appConfigs.apply(sync),
        acceptAppRegistrationNotice: (notice) =>
          acceptAppRegistrationNotice(notice, {
            isRunning: (agentId) => this.#readyRunningAgentIds().includes(agentId),
            mint: (agentId, item) => this.mintAppItem(agentId, item),
          }).then(() => {}),
        migration: this.#migrations
          ? {
              pruneLeftovers: () => this.#migrations!.pruneLeftovers(),
              lease: (lease) => void this.#migrations!.lease(lease),
              cancel: (cancel) => this.#migrations!.cancel(cancel),
            }
          : undefined,
      },
      agentControl: this.#agentControl,
      agentSessions: this.#agentSessions,
      readyRunningAgentIds: () => this.#readyRunningAgentIds(),
      operatingSystem: this.#operatingSystem,
      upgradeResults: this.#upgradeResults,
      runtimeAuth: this.#runtimeAuth,
      runtimeAuthFactory: this.runtimeAuthFactory,
      codeAgentInventory: this.#codeAgentInventory,
      scanUsage: (provider) => this.scanUsage(provider),
      workspaceQueries: this.#workspaceQueries,
      deleteWorkspace: (request) => this.#deleteWorkspace(this.#connection, request),
      sendPiChatFrame: async (frame) => {
        if (this.#stopping || !this.#transport.sendPiChatFrame)
          throw new Error("Pi chat connection unavailable");
        await this.#transport.sendPiChatFrame(frame);
      },
      lifecycle: {
        requestRestart: this.lifecycle.requestRestart,
        requestUpgrade: this.lifecycle.requestUpgrade
          ? (requestId, expectedVersion) => this.#requestUpgrade(requestId, expectedVersion)
          : undefined,
        connectionRefused: this.lifecycle.connectionRefused,
        recoveredRestartRequestIds: this.lifecycle.recoveredRestartRequestIds,
        recoveredUpgradeRequestIds: this.lifecycle.recoveredUpgradeRequestIds,
      },
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
      canonicalAgentMessageTarget: (agentId, target, agentApiKey) =>
        canonicalAgentMessageTarget(
          {
            workspaceId: this.#connection.workspaceId,
            readMessage: this.#transport.agentMessage!.bind(this.#transport),
          },
          agentId,
          target,
          agentApiKey,
        ),
      currentActivityLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
      activityPublisher: this.#activityPublisher,
      drafts: this.#drafts,
      activity: (agentId, detailKind, level, detail, extra) =>
        this.#activity(agentId, detailKind, level, detail, extra),
      messageAttention: this.#messageAttention,
      deliveryQueue: this.#deliveryQueue,
      inputDrain: this.#inputDrain,
      mentionDeliveries: this.#mentionDeliveries,
      launchCustody: this.#launchCustody,
      processManager: this.#agentProcessManager,
      stops: this.#stopState,
      interruptIfBusy: (agentId, launch) => this.#interruptIfBusy(agentId, launch),
      disposeLaunchObservations: (agentId) => this.#disposeLaunchObservations(agentId),
      revokeLocalLaunch: (agentId) =>
        revokeLocalLaunch(this.#agentContexts, this.#agentProxyTokens, this.#agentProxy, agentId),
      stopCoordinator: this.#stopCoordinator,
      cleanupUnconfirmed: (agentId, error) => this.#cleanupUnconfirmed(agentId, error),
      messageOperations: this.#messageOperations,
    });
    this.#shutdown = new RuntimeStop({
      startup: this.#startup,
      coldIdleSweep: this.#coldIdleSweep,
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
      agentApiKeys: this.#agentApiKeys,
      revokeAgentApiKey: (agentId, apiKey) => this.#revokeAgentApiKey(agentId, apiKey),
      replaceTransport: () => this.#replaceTransport(),
      consumedSeqs: this.#consumedSeqs,
      sendAgentStatus: (agentId, status) => this.#sendAgentStatus(agentId, status),
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
  #authorizedAgent(context: string, agentApiKey: string | undefined): string {
    this.#assertRunning();
    const agentId = agentIdForContext(this.#agentContexts, context);
    if (!isAgentApiKey(agentApiKey))
      throw new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING");
    return agentId;
  }

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

  async #replaceTransport(): Promise<unknown> {
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
  }

  /**
   * Asks the Coordinator for an upgrade. Accepted: triggers a report. Refused, or the launch
   * failed: reports that failure with its reason right away, so the server need not wait out its
   * deadline, and rethrows so `DaemonConnection#acceptLifecycleRequest` clears its dedupe.
   * `UpgradeResultReporter` owns the reporting rules.
   */
  async #requestUpgrade(requestId: string, expectedVersion?: string): Promise<void> {
    return requestUpgrade(
      this.lifecycle.requestUpgrade,
      this.#upgradeResults,
      requestId,
      expectedVersion,
      this.#connection.workspaceId,
    );
  }

  async #deleteWorkspace(
    connection: DaemonConfig,
    request: Pick<AgentWorkspaceDeleteRequest, "agentId">,
  ): Promise<Pick<AgentWorkspaceDeleteResult, "status">> {
    return deleteWorkspace(
      connection,
      request,
      this.#agentProcessManager,
      (agentId) => this.stopAgent(agentId),
      (agentId) => this.#forgetLocalAgent(agentId),
    );
  }

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

  #startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    recovery: AgentRecoveryContext | undefined,
    request: LaunchRequest,
  ): Promise<AgentRuntime> {
    return startAgent(
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
      },
      agentId,
      config,
      recovery,
      request,
    );
  }

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
      deliveryQueue: this.#deliveryQueue,
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

  #scheduleStartupFailure(agentId: string, launch: ActivityLaunch): void {
    scheduleStartupFailure(this.#startupFailurePorts(), agentId, launch);
  }

  #startupFailurePorts() {
    return {
      stopping: this.#stopping,
      stops: this.#stopState,
      inputDrain: this.#inputDrain,
      currentActivityLaunches: this.#currentActivityLaunches,
      interruptIfBusy: (id: string, current: ActivityLaunch | undefined) =>
        this.#interruptIfBusy(id, current),
      activityPublisher: this.#activityPublisher,
      disposeLaunchObservations: (id: string) => this.#disposeLaunchObservations(id),
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
        sendAgentStatus: (agentId, status) => this.#sendAgentStatus(agentId, status),
      },
      intent,
      launchId,
    );
  }

  /** Translates one coalesced provider event into cloud Activity, Session and usage updates. */
  #observeRuntimeEvent(
    agentId: string,
    launch: ActivityLaunch,
    config: AgentRuntimeConfig,
    runtime: AgentRuntime,
    controlled: boolean,
    event: AgentRuntimeEvent,
  ): void {
    observeLaunchEvent(
      {
        currentLaunch: (id) => this.#currentActivityLaunches.get(id),
        observation: this.#observationPorts,
      },
      agentId,
      launch,
      config,
      runtime,
      controlled,
      event,
    );
  }

  #failCollectorRunningSlots = (agentId: string, failureReason: string) =>
    failCollectorRunningSlots(this.#transport, this.#agentApiKeys, agentId, failureReason);

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
    return {
      assertOwnIntent: (intent) => this.#assertOwnIntent(intent),
      connection: this.#connection,
      started: this.#startup.started,
      stopping: this.#stopping,
      controlStart: (intent) => this.#agentControl.start(intent),
      controlStop: (intent) => this.#agentControl.stop(intent),
      replaySession: (agentId) => this.#agentSessions.replay(agentId),
      runtime: (agentId) => this.#agentProcessManager.runtime(agentId),
      managed: (agentId) => this.#agentControl.managed(agentId),
      pendingStop: (agentId) => this.#stopState.pendingStop(agentId),
      startAgent: (agentId, config, recovery, request) =>
        this.#startAgent(agentId, config, recovery, request),
      stopAgent: (agentId) => this.stopAgent(agentId),
      resetWorkspace: (request) => this.#agentControl.resetWorkspace(request),
    };
  }

  async handleAgentWorkspaceReset(request: AgentWorkspaceResetRequest): Promise<void> {
    return handleAgentWorkspaceReset(this.#controlIntentPorts(), request);
  }

  async handleAgentStop(intent: AgentStopIntent): Promise<void> {
    return handleAgentStop(this.#controlIntentPorts(), intent);
  }

  async handleAgentTurnInterrupt(intent: AgentTurnInterruptIntent): Promise<void> {
    return handleAgentTurnInterrupt(
      {
        assertOwnIntent: (intent) => this.#assertOwnIntent(intent),
        launch: (agentId) => this.#currentActivityLaunches.get(agentId),
        interrupt: (agentId, options) => this.#agentProcessManager.interruptTurn(agentId, options),
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

  /**
   * Answers a server-side liveness probe with the Agent's real current activity, first match wins:
   * `Message received` while a message delivered to it waits unread in its attention (unless the
   * fingerprint fence holds its deliveries), the starting frame while its launch starts, the
   * remembered last busy activity when one is live for the current launch, otherwise idle. An
   * Agent that is not running at all gets no reply; the process presence lease already tells the
   * server the process is gone. Never mutates any other runtime state.
   */
  async handleAgentActivityProbe(probe: AgentActivityProbe): Promise<void> {
    return this.#agentOperations.handleActivityProbe(probe);
  }

  async handleAgentMessage(message: AgentMessageDelivery): Promise<void> {
    return handleAgentMessage(this.#messageDeliveryPorts(), message);
  }

  /** The launch and native session a tracked mention may name: the ones last reported for this
   * Agent, while that launch is the one running. */
  #runningMentionIdentity(agentId: string): RunningMentionIdentity | undefined {
    return runningMentionIdentity(
      agentId,
      this.#agentProcessManager,
      this.#reportedSessions,
      this.#currentActivityLaunches,
    );
  }

  /** Sends a session report, and remembers the launch and session it names for tracked
   * mentions. */
  async #reportAgentSession(report: AgentSessionReport): Promise<void> {
    await this.#transport.reportAgentSession?.(report);
    this.#reportedSessions.set(report.agentId, {
      launchId: report.launchId,
      sessionId: report.sessionId,
    });
  }

  #wakeAgent(agentId: string, restart: WakeRestart): Promise<AgentRuntime> {
    return beginWakeLaunch(
      agentId,
      this.#startAgent(agentId, restart.config, undefined, wakeRequest(restart)),
      this.#wakeLaunches,
      this.#wakeLaunchFailures,
    );
  }

  /** Drops an Agent's local state for channels it can no longer read: waiting deliveries (each
   * acknowledged, so a rejoin does not bring them back on `ready`) and the pending attention of
   * those channels and their threads. */
  handleAgentInboxPurge(purge: AgentInboxPurge): void {
    return this.#agentOperations.handleInboxPurge(purge);
  }

  stopAgent(agentId: string): Promise<void> {
    return this.#agentOperations.stopAgent(agentId);
  }

  /** Forgets one ended launch's observation state without affecting another Agent. */
  #disposeLaunchObservations(agentId: string): void {
    disposeLaunchObservations(
      agentId,
      this.#currentActivityLaunches,
      this.#phaseBookkeeping,
      this.#usageReport,
      this.#fastModeWarned,
    );
  }

  #readyRunningAgentIds(): string[] {
    return readyRunningAgentIds(this.#agentProcessManager, this.#agentLaunches, this.#stopState);
  }

  #activity(
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra: Partial<ActivityDraft> = {},
  ): ActivityDraft {
    return activityDraft(this.#connection.workspaceId, agentId, detailKind, level, detail, extra);
  }

  #turnPorts() {
    return {
      messageAttention: this.#messageAttention,
      activityPublisher: this.#activityPublisher,
      deliveryQueue: this.#deliveryQueue,
      inboxCoordinator: this.#inboxCoordinator,
      launchCustody: this.#launchCustody,
      processManager: this.#agentProcessManager,
      currentActivityLaunches: this.#currentActivityLaunches,
      phaseBookkeeping: this.#phaseBookkeeping,
      runtimeRelease: this.#runtimeRelease,
      systemCleaner: this.systemCleaner,
      idleNudge: this.#launchCoordinator.idleNudge,
      drafts: this.#drafts,
      activity: (
        agentId: string,
        kind: AgentActivity["detailKind"],
        level: AgentActivity["level"],
        detail: string,
        extra?: Partial<ActivityDraft>,
      ) => this.#activity(agentId, kind, level, detail, extra),
      isWorking: (agentId: string) => isWorking(this.#turnPorts(), agentId),
    };
  }

  #narrateUnavailable(
    agentId: string,
    launch: ActivityLaunch,
    { detail, entryText }: { detail: string; entryText?: string },
  ): void {
    narrateUnavailable(this.#turnPorts(), agentId, launch, detail, entryText);
  }
  #flushHeldDeliveries(agentId: string, held: AgentMessageDelivery[]): void {
    flushHeldDeliveries(this.#turnPorts(), agentId, held);
  }
  #interruptIfBusy(agentId: string, activityLaunch: ActivityLaunch | undefined): void {
    interruptIfBusy(this.#turnPorts(), agentId, activityLaunch);
  }
  #showQuietTurn(
    agentId: string,
    launch: ActivityLaunch,
    publish: (agentId: string, launch: ActivityLaunch, activity: ActivityDraft) => void,
  ): void {
    showQuietTurn(this.#turnPorts(), agentId, launch, publish);
  }
  #reconcileIdleTurn(agentId: string, launch: ActivityLaunch): boolean {
    return reconcileIdleTurn(this.#turnPorts(), agentId, launch);
  }
  #releaseSurvivingHolds(agentId: string): void {
    releaseSurvivingHolds(this.#turnPorts(), agentId);
  }
  #isWorking(agentId: string): boolean {
    return isWorking(this.#turnPorts(), agentId);
  }
  #releaseTurnEndHolds(agentId: string): void {
    releaseTurnEndHolds(this.#turnPorts(), agentId);
  }

  /** The Agent no longer lives on this Computer: its workspace was deleted or moved away. */
  #forgetLocalAgent(agentId: string): void {
    this.#inboxCoordinator.forgetAgent(agentId, {
      systemCleaner: this.systemCleaner,
      offlineResidency: this.#offlineResidency,
      messageAttention: this.#messageAttention,
      consumedSeqs: this.#consumedSeqs,
      featureSync: this.#sync,
    });
  }

  #sendAgentStatus(agentId: string, status: "active" | "inactive"): void {
    sendAgentStatus(this.#statusReportPorts, agentId, status);
  }

  #cleanupUnconfirmed(agentId: string, error: unknown): boolean {
    return cleanupUnconfirmed(agentId, error, (id) => this.#agentProcessManager.isStopping(id));
  }

  /** The error Activity for a launch that did not start; `agent-failure-presentation` builds it. */
  #launchFailureActivity(
    agentId: string,
    provider: RuntimeProvider,
    error: unknown,
  ): ActivityDraft {
    return buildLaunchFailureActivity(agentId, provider, error, this.#drafts, (id, err) =>
      this.#cleanupUnconfirmed(id, err),
    );
  }

  async #revokeAgentApiKey(agentId: string, agentApiKey: string | undefined): Promise<void> {
    await revokeAgentApiKey(this.#transport, this.#agentApiKeys, agentId, agentApiKey);
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

  async #acceptReminderDue(job: ReminderJob, late: boolean): Promise<boolean> {
    return acceptReminderDue(this.#agentApiRemindersPorts(), job, late);
  }

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

  /** Stops admitting new Agent turns and reports which Agents are still busy. */
  holdRunners(reason: RunnerHoldReason): BusyAgentReport[] {
    const runtime = this;
    return holdRunners(
      {
        get hold() {
          return runtime.#runnerHold;
        },
        set hold(value) {
          runtime.#runnerHold = value;
        },
      },
      reason,
      this.#activityPublisher,
    );
  }

  /** Lifts the hold and resumes every delivery queued behind it, in arrival order. */
  releaseRunners(): BusyAgentReport[] {
    const runtime = this;
    return releaseRunners(
      {
        get hold() {
          return runtime.#runnerHold;
        },
        set hold(value) {
          runtime.#runnerHold = value;
        },
      },
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
