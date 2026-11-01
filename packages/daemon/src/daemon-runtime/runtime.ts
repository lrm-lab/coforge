import { subscribeRuntimeAuth } from "./runtime-auth-subscription";
import { subscribeWorkspaceQueries } from "./workspace-query-handlers";
import type { RuntimeAuthController } from "./runtime-auth-controller";
import { createRuntimeAuthAdapter } from "#src/code-agent/registry";
import type { RuntimeAuthAdapter, RuntimeAuthProvider } from "@lrm/coforge-anvil";
import {
  AgentProcessCleanupError,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type UsageSnapshot,
} from "@lrm/coforge-anvil";
import { mkdirSync } from "node:fs";
import { OperatingSystemInfo } from "#src/platform/operating-system";
import { FileConversationSessionStore } from "#src/persistence/conversation-session-store";
import { escapePathIdentity } from "#src/persistence/path-scope";
import { AgentInputDrain } from "./agent-input-drain";
import { rebindAgent } from "./agent-rebind";
import { AgentLaunchCustody } from "./agent-launch-custody";
import { AgentContexts } from "./agent-contexts";
import { PhaseBookkeeping } from "./phase-bookkeeping";
import {
  observeRuntimeEvent,
  type RuntimeEventObservationPorts,
} from "./runtime-event-observation";
import { interruptAgentTurn } from "./turn-interrupt";
import { heldTaskResult } from "./held-task-result";
import type { AgentProxy, LaunchRequest, SessionMode } from "./runtime-launch-types";
import {
  AgentProcessManager,
  type CodeAgentProviderFactory,
  type AgentRestartConfig,
  type AgentRuntime,
} from "#src/agent-runtime/agent-process-manager";
import { type SessionReference } from "./launch-identity";
import { connectionSessionInvalidate } from "./session-invalidate-activity";
import { activityDraft } from "./activity-draft";
import { recoveryOf, runtimeConfigOf, type AgentRecoveryContext } from "./runtime-launch-intent";
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
import { PiChatRelay } from "#src/pi-chat/relay";
import { readyCapabilities } from "./ready-capabilities";
import type {
  DaemonConnectionClient,
  DaemonConnectionClientFactory,
} from "#src/connection/daemon-connection-client";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "#src/connection/shutdown-notice-timeout";
import { DaemonConnectionStoppedError } from "#src/connection/daemon-connection-stopped-error";
import {
  type DaemonConnectRejectionReason,
  WORKSPACE_PROTOCOL_MAJOR,
  type DaemonShutdownReason,
  type RunnerHoldReason,
  AGENT_MESSAGE_REJECT_METHOD,
  MENTION_DELIVERY_TERMINAL_CODES,
  AGENT_ACTIVITY_DETAIL_KIND,
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
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type UsageScanResponse,
  CLEANER_APP_ID,
  type AgentReminderOperationRequest,
  type LocalReminderRequest,
  type ReminderJob,
  type ReminderSync,
  type TaskCommand,
  type TaskResult,
  type AgentWorkspaceDeleteRequest,
  type AgentWorkspaceDeleteResult,
} from "@lrm/coforge-sdk/internal";
import { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import { AgentMigrationBucketClient } from "#src/connection/agent-migration-bucket-client";
import { usageScanFailure, usageScanReading, usageScanResult } from "./usage-scan-response";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentRuntimeState } from "#src/agent-runtime/agent-runtime-state";
import { MemoryAgentRuntimeStateStore } from "#src/persistence/memory-agent-runtime-state-store";
import { AgentWorkspaceQueries } from "./agent-workspace-queries";
import { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import { AgentStopCoordinator } from "./agent-stop-coordinator";
import { AgentLaunchCoordinator } from "./agent-launch-coordinator";
import { startAgent } from "./agent-start-coordinator";
import { deleteWorkspace, requestUpgrade } from "./runtime-lifecycle-operations";
import { assertOwnIntent } from "./runtime-intent-validation";
import { currentObservedUsage } from "./runtime-usage-observation";
import { failCollectorRunningSlots } from "./runtime-collector-failure";
import { runtimeEnvelope } from "./runtime-envelope";
import { abandonLaunch, scheduleStartupFailure } from "./agent-startup-failure";
import { agentsDirectory, agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { revokeAgentApiKey } from "./agent-api-key-revoke";
import { ColdIdleSweep } from "./cold-idle-sweep";
import { StalledRecoverySweep } from "./stalled-recovery-sweep";
import { CatalogFreshnessSweep } from "./catalog-freshness-sweep";
import { rememberUsage } from "./usage-memory";
import { dropHeldMentionsWithoutSession } from "./held-mention-sweep";
import { runtimeMachineStatus } from "./machine-status-reporter";
import { agentActivityDrafts } from "./agent-activity-drafts";
import { sendAgentStatus, type AgentStatusReportPorts } from "./agent-status-report";
import { agentIdForContext, contextFor } from "./agent-context";
import {
  cleanupUnconfirmed,
  launchFailureDraft,
  stopFailureMessage,
} from "./agent-failure-presentation";
import { RuntimeRelease } from "./runtime-release";
import { AgentFeatureSync } from "./agent-feature-sync";
import { WakeRecycle } from "./wake-recycle";
import { AgentMessageOperations } from "./agent-message-operations";
import { AgentRequestForwarder } from "./agent-request-forwarder";
import { AgentDeliveryQueue } from "./agent-delivery-queue";
import { canonicalThreadTarget } from "./thread-target";
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
  type TrackedMentionDelivery,
} from "./mention-delivery-tracker";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type { MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import { reminderDueItemId } from "#src/agent-app-inbox/registry";
import { SystemCleaner, type SystemCleanerOptions } from "#src/system-cleaner/system-cleaner";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import { AgentPreflightError } from "./agent-preflight-error";
import { shutdownReasonForHold, type RunnerHold } from "./shutdown-reason";
import { CodeAgentInventorySync, type CodeAgentDiscovery } from "./code-agent-inventory-sync";
import { RuntimeAuthReporter } from "./runtime-auth-reporter";
import { subscribeProviderScans } from "./provider-scan-handlers";
import { subscribeRuntimeReconnect } from "./runtime-reconnect";
import { RuntimePublicationSubscriptions } from "./runtime-publication-subscriptions";
import {
  UpgradeResultReporter,
  type RecoveredUpgradeResult,
  type UpgradeOperationsReading,
} from "./upgrade-result-reporter";
import type { UnrefTimerSchedule } from "./unref-timer";
import { getLogger } from "@logtape/logtape";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import {
  ReminderScheduler,
  reminderAppInboxPreview,
  reminderAppInboxSummary,
} from "#src/agent-reminder/reminder-scheduler";
import { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import { FileReminderReceiptStore } from "#src/persistence/reminder-receipt-store";
import { logAgentApiKeyRevokeFailed, logAgentOperationFailure } from "./agent-failure-logs";
import { acceptAppRegistrationNotice } from "#src/agent-app-inbox/app-registration-notice";
import { diagnosticErrorCode, diagnosticErrorName } from "@lrm/coforge-sdk/internal";
import type { AgentVersionResponse } from "@lrm/coforge-sdk/agent";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Per-provider reading deadline supplied by a runtime usage scan. */
export const USAGE_SCAN_READ_TIMEOUT_MS = 10_000;

const NOT_RUNNING = "daemon runtime is not running";

/** A daemon-owned resident runtime for one supervised Workspace. */
export class DaemonRuntime {
  readonly #connection: DaemonConfig;
  readonly #drafts: ReturnType<typeof agentActivityDrafts>;
  readonly #createProvider: CodeAgentProviderFactory;
  readonly #agentProcessManager: AgentProcessManager;
  readonly #credentials: DaemonCredentialStore;
  readonly #transportFactory: DaemonConnectionClientFactory;
  #transport: DaemonConnectionClient;
  #startPromise: Promise<void> | undefined;
  /** Aborted by `stop`, so a start still waiting for the cloud never holds a stop up. */
  #startAbort: AbortController | undefined;
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #stopping = false;
  #subscriptions: Array<() => void> = [];
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
   * does not launch the Agent again. No attempt cap; the cooldown stops growing at its ceiling. */
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
    sendAgentDeliveryRejection: async (message, reason) => {
      await this.#transport.sendAgentDeliveryRejection?.({
        protocolMajor: message.protocolMajor,
        requestId: message.requestId,
        messageId: message.messageId,
        deliveryId: message.deliveryId,
        workspaceId: message.workspaceId,
        agentId: message.agentId,
        sequence: message.sequence,
        reason,
        method: AGENT_MESSAGE_REJECT_METHOD,
      });
    },
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
    lastBusyLaunch: (agentId) => this.#activityPublisher.lastBusy(agentId)?.launch,
    resumable: (agentId) => this.#runningMentionIdentity(agentId) !== undefined,
    sessionId: (agentId) => this.#sessionReferences.get(agentId)?.sessionId,
    isStopping: (agentId) => this.#stoppingAgents.has(agentId),
    daemonIdleFacts: (agentId) => {
      const queue = this.#inputDrain.get(agentId);
      return {
        working: this.#isWorking(agentId),
        deliveriesQueued: this.#deliveryQueue.hasQueued(agentId),
        inputsQueued: queue !== undefined && (queue.items.length > 0 || queue.drain !== undefined),
        launching: this.#agentLaunches.has(agentId),
        stopping:
          this.#stoppingAgents.has(agentId) ||
          this.#agentStops.has(agentId) ||
          this.#agentProcessManager.isStopping(agentId),
        runnerHold: this.#runnerHold !== undefined,
        migrating: this.#migrations?.holds(agentId) === true,
      };
    },
    hasParkedWork: (agentId) =>
      this.#deliveryQueue.hasQueued(agentId) || this.#deliveryQueue.hasHeldAppItems(agentId),
    flushParked: (agentId) => this.#releaseSurvivingHolds(agentId),
    wake: (agentId, restart) => this.#wakeAgent(agentId, restart),
    publish: (agentId, launch, level, detailKind, text) =>
      this.#activityPublisher.publish(
        agentId,
        launch,
        this.#activity(agentId, detailKind, level, text),
      ),
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
  readonly #stalledRecoverySweep = new StalledRecoverySweep<ActivityLaunch>({
    agentIds: () => this.#agentProcessManager.runningAgentIds(),
    hasQueuedDeliveries: (agentId) => this.#deliveryQueue.hasQueued(agentId),
    runnerHold: () => this.#runnerHold !== undefined,
    isStopping: (agentId) => this.#stoppingAgents.has(agentId),
    isRecovering: (agentId) => this.#runtimeRelease.isRecovering(agentId),
    stalled: (agentId) => this.#runtimeRelease.stalled(agentId),
    recover: (agentId, stalled) => this.#runtimeRelease.recoverStalled(agentId, stalled),
  });
  /** Re-reads model catalogs whose on-disk key changed: an update, a sign-in or a sign-out. */
  readonly #catalogFreshnessSweep = new CatalogFreshnessSweep({
    transport: () => (this.#started && !this.#stopping ? this.#transport : undefined),
    recheck: (transport) => this.#codeAgentInventory.recheckCatalogs(transport),
  });
  /** The OS version the ready report carries; read once, off the ready path. */
  readonly #operatingSystem = new OperatingSystemInfo();
  /** Reports this machine's disk and memory while the connection is up. */
  readonly #machineStatus = runtimeMachineStatus({
    connection: () => this.#connection,
    dataDirectory: () => this.stateDirectory,
    transport: () => (this.#started && !this.#stopping ? this.#transport : undefined),
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
  #migrationsClosed: Promise<void> | undefined;
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
  readonly #sessionReferences = new Map<string, SessionReference>();
  readonly #inputDrain = new AgentInputDrain({
    runnerHeld: () => this.#runnerHold !== undefined,
    sessionFor: (agentId) => this.#agentProcessManager.session(agentId),
    launchFor: (agentId) => this.#currentActivityLaunches.get(agentId),
    hasQueuedDeliveries: (agentId) => this.#deliveryQueue.hasQueued(agentId),
    isLaunching: (agentId) => this.#agentLaunches.has(agentId),
    isStopping: (agentId) => this.#stoppingAgents.has(agentId),
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
  readonly #stoppingAgents = new Set<string>();
  readonly #desktops = createAgentDesktopHolds();
  readonly #agentStops = new Map<string, Promise<void>>();
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
    sessionId: (agentId) => this.#sessionReferences.get(agentId)?.sessionId,
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
    active: () => this.#started,
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
  #runtimeAuthControl: RuntimeAuthController | undefined;
  readonly #upgradeResults: UpgradeResultReporter;
  #piChat?: PiChatRelay;
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
    const recovered = { results: lifecycle.recoveredUpgradeResults ?? [], pending: false };
    this.#upgradeResults = new UpgradeResultReporter({
      workspaceId: connection.workspaceId,
      computerId: connection.computerId ?? "",
      readOperations: lifecycle.readUpgradeOperations ?? (async () => recovered),
      transport: () => this.#transport,
      acknowledge: lifecycle.acknowledgeUpgradeResult,
      schedule: lifecycle.upgradeResultSchedule,
    });
    this.#mentionDeliveries = new MentionDeliveryTracker(connection.computerId, {
      transition: (report) =>
        this.#transport.sendAgentMentionDeliveryTransition?.(report) ?? Promise.resolve(),
      terminalError: (report) =>
        this.#transport.sendAgentMentionDeliveryTerminalError?.(report) ?? Promise.resolve(),
      acknowledge: (message) => this.#messageAttention.acknowledge(message),
      running: (agentId) => this.#runningMentionIdentity(agentId),
      consumed: (message) => this.#messageAttention.hasConsumed(message),
      told: (message) => this.#messageAttention.wasNotified(message),
      decided: (message, outcome) => this.#messageAttention.logDecision(message, outcome),
      announce: (message) => this.#messageAttention.announce(message),
      busy: (agentId, conversationId) =>
        (conversationId
          ? this.#agentProcessManager.session(agentId)?.hasLiveTurnForConversation?.(conversationId)
          : undefined) ?? this.#deliveryQueue.isBusy(agentId),
      blocked: (agentId) =>
        this.#deliveryQueue.explicitHold(agentId) ??
        (this.#deliveryQueue.shouldHold(agentId) ? "queued_until_idle" : undefined),
    });
    this.#messageAttention = new AgentMessageAttentionIndex(
      connection.workspaceId,
      this.#agentProcessManager,
      (ack) => this.#transport.sendAgentDeliveryAck?.(ack) ?? Promise.resolve(),
      (agentId, conversation) => {
        try {
          this.#activityPublisher.publishCurrent(
            agentId,
            this.#activity(
              agentId,
              AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
              "info",
              "Message received",
              {
                entries: [],
                ...(conversation
                  ? {
                      conversationId: conversation.conversationId,
                      conversationTarget: conversation.target,
                    }
                  : {}),
              },
            ),
          );
          const launch = this.#currentActivityLaunches.get(agentId);
          if (launch) this.#reconcileIdleTurn(agentId, launch);
        } catch {
          // Best-effort observation must not turn accepted input into failed delivery.
        }
      },
      {
        shouldHold: (agentId) => this.#deliveryQueue.shouldHold(agentId),
        queued: (agentId) => this.#deliveryQueue.pending(agentId),
        enqueue: (agentId, message) => this.#deliveryQueue.enqueue(agentId, message),
        busy: (agentId) => {
          if (!this.#deliveryQueue.isBusy(agentId)) this.#launchCustody.noteTurnStarted(agentId);
          this.#deliveryQueue.busy(agentId);
        },
        noticeSettled: (agentId) => {
          const launch = this.#currentActivityLaunches.get(agentId);
          if (launch) this.#reconcileIdleTurn(agentId, launch);
        },
        consumedSeqs: this.#consumedSeqs,
        noticePrefix: (agentId) => this.#sync.noticePrefix(agentId),
      },
    );
    this.#inboxCoordinator = new AgentInboxCoordinator({
      workspaceId: connection.workspaceId,
      stateDirectory,
      consumedSeqs: this.#consumedSeqs,
      messageAttention: this.#messageAttention,
      deliveryQueue: this.#deliveryQueue,
      runtimeRelease: this.#runtimeRelease,
      processManager: this.#agentProcessManager,
      startAgent: (agentId, config, sessionId) =>
        this.#startAgent(agentId, config, undefined, { sessionId }),
      currentActivityLaunch: (agentId) => this.#currentActivityLaunches.get(agentId),
      reconcileIdleTurn: (agentId, launch) => this.#reconcileIdleTurn(agentId, launch),
      mentionDeliveries: this.#mentionDeliveries,
      assertRunning: () => this.#assertRunning(),
      agentIdForContext: (context) => this.#agentIdForContext(context),
    });
    this.agentRequests = new AgentRequestForwarder({
      get transport() {
        return runtime.#transport;
      },
      connection,
      authorizedAgent: (context, agentApiKey) => this.#authorizedAgent(context, agentApiKey),
    });
    this.#messageOperations = new AgentMessageOperations({
      connection,
      attention: this.#messageAttention,
      isMemoryAgent: (agentId) => Boolean(this.memoryFence(agentId)),
      contexts: this.#contexts,
      inbox: (agentId) => this.#inboxCoordinator.agentInbox(agentId),
      appItemsPending: (agentId) => this.#inboxCoordinator.appItemsPending(agentId),
      get transport() {
        return runtime.#transport;
      },
      reportFreshnessHold: (agentId, activity) =>
        this.#activityPublisher.publishCurrent(
          agentId,
          this.#activity(
            agentId,
            AGENT_ACTIVITY_DETAIL_KIND.FRESHNESS_HOLD,
            "info",
            activity.detail,
            {
              activityKind: activity.activityKind,
              entries: activity.entries,
              producerFactId: activity.producerFactId,
            },
          ),
        ),
    });
    this.#reminders = new ReminderScheduler(
      { workspaceId: connection.workspaceId, computerId: connection.computerId },
      new FileReminderReceiptStore(stateDirectory, connection.workspaceId, connection.computerId),
      (request) => {
        if (!this.#transport.fireReminder) throw new Error("reminder fire is unavailable");
        return this.#transport.fireReminder(request);
      },
      (job, occurrence) => this.#acceptReminderDue(job, occurrence.late),
    );
    this.systemCleaner = new SystemCleaner({
      ...systemCleaner,
      agentsDirectory: agentsDirectory(connection.workspaceRoot, connection.workspaceId),
      inbox: {
        upsert: async (agentId, item) =>
          (await this.#inboxCoordinator.appInbox(agentId)).upsert(item),
        remove: (agentId, itemId) => this.#inboxCoordinator.removeAppItem(agentId, itemId),
      },
      wake: async (agentId, itemId) => {
        // A busy Agent sees the item at its next idle drain; a stopped one at its next launch.
        if (this.#isWorking(agentId)) return;
        await this.#inboxCoordinator.notifyAppItem(agentId, itemId, { startStopped: false });
      },
    });
    this.#appConfigs = new AgentAppConfigSync({
      // `#requestAppConfigSnapshot` asks only through a transport that has the method.
      requestSnapshot: (agentId) =>
        this.#transport.requestAppConfigSnapshot!({
          ...this.#env(),
          agentId,
        }),
      apps: { [CLEANER_APP_ID]: this.systemCleaner },
    });
    // The transport is replaced on each start, so the runner reaches the route through whichever
    // one is current.
    this.#migrations = this.#transport.agentMigrationServer
      ? new AgentMigrationRunner({
          server: () => this.#transport.agentMigrationServer!(),
          bucket: new AgentMigrationBucketClient(),
          agents: {
            stop: (agentId) => this.stopAgent(agentId),
            isRunning: (agentId) => this.#agentProcessManager.runningAgentIds().includes(agentId),
            movedAway: (agentId) => this.#forgetLocalAgent(agentId),
          },
          workspaceDirectory: (agentId) =>
            agentWorkspaceDirectory(connection.workspaceRoot, connection.workspaceId, agentId),
          stateDirectory,
        })
      : undefined;
    const state = new AgentRuntimeState(
      // Control state lives only in this process: the server
      // re-dispatches what should still be running after a restart, so a persisted record could
      // only outlive the writer it was waiting on.
      new MemoryAgentRuntimeStateStore(connection.workspaceRoot, connection.workspaceId),
    );
    this.#agentSessions = new AgentSessions(state, async (snapshot) => {
      await this.#reportAgentSession({
        protocolMajor: snapshot.protocolMajor,
        requestId: crypto.randomUUID(),
        workspaceId: snapshot.workspaceId,
        computerId: snapshot.computerId,
        agentId: snapshot.agentId,
        provider: snapshot.provider,
        startRequestId: snapshot.requestId,
        daemonInstanceId: snapshot.daemonInstanceId ?? this.#runtimeInstanceId,
        launchId: snapshot.launchId,
        sessionId: snapshot.identity.sessionId,
        sessionState: snapshot.identity.state,
        controlEpoch: snapshot.epoch,
        sequence: snapshot.sequence,
      });
    });
    this.#agentControl = new AgentControl(this.#runtimeInstanceId, state, this.#agentSessions, {
      running: (agentId) => Boolean(this.#agentProcessManager.session(agentId)),
      stop: async (agentId) => {
        const session = this.#agentProcessManager.session(agentId);
        await this.stopAgent(agentId);
        return session?.readSessionIdentity?.();
      },
      launch: async (intent, launchId, replacedSessionId, invalidateReason) => {
        if (replacedSessionId) this.#sessionReferences.delete(intent.agentId);
        const runtime = await this.#startAgent(
          intent.agentId,
          runtimeConfigOf(intent),
          recoveryOf(intent),
          {
            sessionId: intent.sessionId,
            requestId: intent.requestId,
            previousLaunchId: intent.previousLaunchId,
            sessionMode: intent.sessionMode,
            resumePrompt: intent.resumePrompt,
            introductionPrompt: intent.introductionPrompt,
            control: { controlEpoch: intent.controlEpoch, launchId },
            replacedSessionId,
            invalidateReason,
          },
        );
        return runtime.session.readSessionIdentity?.();
      },
      wake: async (intent) => {
        await this.#startAgent(
          intent.agentId,
          runtimeConfigOf(intent),
          { wakeMessage: intent.wakeMessage },
          {
            requestId: intent.requestId,
            resumePrompt: intent.resumePrompt,
            introductionPrompt: intent.introductionPrompt,
          },
        );
      },
      rebind: (intent, launchId) => this.#rebindAgent(intent, launchId),
      startSettled: (agentId) => this.#exitedDelivery.releaseStartBuffer(agentId),
      // `launchId` is always present here (minted synchronously by `AgentControl.start()`
      // before this call); the wire message and the retry's cold-start Activity
      // (`#launchAgent`'s `request.invalidateReason` narration) both follow that same,
      // effectively-unconditional signal — there is no longer a separate controlEpoch gate.
      invalidateSession: (intent, launchId, sessionId, reason) => {
        this.#transport.sendSessionInvalidate?.(
          connectionSessionInvalidate(this.#connection, this.#runtimeInstanceId, {
            agentId: intent.agentId,
            provider: intent.provider,
            sessionId,
            launchId,
            reason,
          }),
        );
      },
      result: async (result) => {
        await this.#transport.sendAgentControlResult?.(result);
      },
    });
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
      sessionReferences: this.#sessionReferences,
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
      stoppingAgents: this.#stoppingAgents,
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
      agentStops: this.#agentStops,
      isStopping: () => this.#stopping,
      assertRunning: () => this.#assertRunning(),
      assertAgentNotStopping: (agentId) => this.#assertAgentNotStopping(agentId),
      contextFor: (agentId) => this.#contextFor(agentId),
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
        this.#revokeLocalLaunch(agentId, context, proxyToken),
      revokeAgentApiKey: (agentId, apiKey) => this.#revokeAgentApiKey(agentId, apiKey),
      launchFailureActivity: (agentId, provider, error) =>
        this.#launchFailureActivity(agentId, provider, error),
      drainAppInboxNotices: (agentId) => this.#inboxCoordinator.drainAppInboxNotices(agentId),
    });
  }

  get agentProcessManager(): AgentProcessManager {
    return this.#agentProcessManager;
  }

  #assertRunning(): void {
    if (this.#stopping || !this.#started)
      throw new AgentPreflightError(NOT_RUNNING, "DAEMON_NOT_RUNNING");
  }

  #assertAgentNotStopping(agentId: string): void {
    if (this.#stoppingAgents.has(agentId) || this.#agentProcessManager.isStopping(agentId))
      throw new Error(`Agent runtime is stopping: ${agentId}`);
  }

  /** Resolves the Agent behind a local context and checks its API key; the transport is checked by the caller. */
  #authorizedAgent(context: string, agentApiKey: string | undefined): string {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!isAgentApiKey(agentApiKey))
      throw new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING");
    return agentId;
  }

  async scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse> {
    this.#assertRunning();
    const now = () => new Date();
    // Cursor, OpenCode, Pi, and CoForge have no reader yet. Say that the reader is not
    // connected. Do not claim the official product has no quota endpoint.
    if (!RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider])
      return usageScanResult("unsupported", undefined, "Usage reader is not connected yet");
    const codeAgentProvider = this.#createProvider(provider);
    if (!codeAgentProvider.readUsage)
      return usageScanResult("unsupported", undefined, "Usage reader is not connected yet");
    try {
      // An observed snapshot (`#rememberUsage` stamps when it was observed) is the fallback for a
      // provider with no reading of its own.
      const snapshot =
        (await codeAgentProvider.readUsage({
          workingDirectory: this.#connection.workspaceRoot,
          timeoutMs: USAGE_SCAN_READ_TIMEOUT_MS,
        })) ?? this.#currentObservedUsage(provider);
      return usageScanReading(snapshot, now);
    } catch (error) {
      return usageScanFailure(error, () => this.#currentObservedUsage(provider), now);
    }
  }

  start(connection: DaemonConfig): Promise<void> {
    if (
      connection.workspaceId !== this.#connection.workspaceId ||
      connection.computerId !== this.#connection.computerId
    ) {
      throw new Error("Daemon cannot be started for another Workspace connection");
    }
    if (this.#stopping) return Promise.reject(new DaemonConnectionStoppedError());
    if (this.#started) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;

    const startAbort = new AbortController();
    this.#startAbort = startAbort;
    this.#startPromise = this.#start(connection, startAbort.signal).finally(() => {
      this.#startPromise = undefined;
      this.#startAbort = undefined;
    });
    return this.#startPromise;
  }

  /**
   * Stops the current transport and installs a fresh one, so a later start never reuses a
   * transport that went through `.stop()` and no replaced transport is left connected. Resolves
   * with the stop failure, if any.
   *
   * The fresh transport is installed before the old one is stopped, on purpose: stopping waits
   * on in-flight status RPCs, and nothing that runs meanwhile may still reach the transport being
   * torn down (a late `stop()` of it, or a start racing this one, must see the new one).
   */
  async #replaceTransport(): Promise<unknown> {
    const replaced = this.#transport;
    this.#transport = this.#transportFactory.create(this.#connection);
    try {
      await replaced.stop();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  #subscribe(unsubscribe: (() => void) | undefined): void {
    if (unsubscribe) this.#subscriptions.push(unsubscribe);
  }

  #unsubscribeAll(): void {
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
  }

  async #start(connection: DaemonConfig, signal: AbortSignal): Promise<void> {
    mkdirSync(connection.workspaceRoot, { recursive: true });
    const token = await this.#credentials.load(connection.workspaceId, connection.computerId);
    if (!token) throw new Error("Workspace credential is missing");
    const publications = new RuntimePublicationSubscriptions({
      transport: this.#transport,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
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
    });
    try {
      const auth = subscribeRuntimeAuth(this.#transport, {
        owner: {
          protocolMajor: 1,
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
        },
        workingDirectory: connection.workspaceRoot,
        createAdapter: this.runtimeAuthFactory,
        refresh: () => this.#runtimeAuth.refresh(),
        refreshProvider: (provider) => this.#runtimeAuth.refreshProvider(provider),
      });
      this.#runtimeAuthControl = auth?.controller;
      this.#subscribe(auth?.unsubscribe);
      this.#upgradeResults.start();
      this.#subscribe(
        subscribeRuntimeReconnect(this.#transport, {
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          refreshInventory: (transport) => {
            void this.#codeAgentInventory
              .reportRuntimes(transport)
              .then((report) => this.#codeAgentInventory.refreshStaleCatalogs(report, transport))
              .catch(() => {});
          },
          runningAgentIds: () => this.#readyRunningAgentIds(),
          requestReminderSnapshot: (agentId) => this.#requestReminderSnapshot(agentId),
          resyncAppConfigs: () => this.#resyncAppConfigs(),
          replayAgentControl: () => this.#agentControl.replay(),
          replayAgentSessions: () => this.#agentSessions.replay(),
          reportUpgradeResults: () => this.#upgradeResults.report(),
        }),
      );
      const transport = this.#transport;
      this.#piChat ??= new PiChatRelay(connection, async (frame) => {
        if (this.#stopping || !this.#transport.sendPiChatFrame)
          throw new Error("Pi chat connection unavailable");
        await this.#transport.sendPiChatFrame(frame);
      });
      this.#subscribe(
        transport.onPiChatRequest?.(async (request) => {
          if (
            this.#stopping ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          await this.#piChat?.execute(request);
        }),
      );
      for (const unsubscribe of subscribeWorkspaceQueries(transport, {
        connection,
        observations: this.#workspaceQueries,
        deleteWorkspace: (request) => this.#deleteWorkspace(connection, request),
        currentTransport: () => this.#transport,
        isStopping: () => this.#stopping,
      }))
        this.#subscribe(unsubscribe);
      for (const unsubscribe of subscribeProviderScans(this.#transport, {
        connection,
        runtime: this,
        currentTransport: () => this.#transport,
        isStopping: () => this.#stopping,
        runtimeAuth: this.#runtimeAuth,
        inventory: this.#codeAgentInventory,
      }))
        this.#subscribe(unsubscribe);
      // Register publication listeners after the auxiliary query/scanning listeners, matching the
      // original start order; the server may recover persisted Agents immediately at ready.
      for (const unsubscribe of await publications.install()) this.#subscribe(unsubscribe);
      await this.#transport.start(token, {
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        serverHttpUrl: connection.serverHttpUrl,
        requestRestart: this.lifecycle.requestRestart,
        requestUpgrade: this.lifecycle.requestUpgrade
          ? (requestId, expectedVersion) => this.#requestUpgrade(requestId, expectedVersion)
          : undefined,
        signal,
      });
      await this.#agentControl.replay();
      await this.#agentSessions.replay();
      // Off the event loop, once: the OS version only changes with an upgrade.
      await this.#operatingSystem.read();
      await this.#transport.ready(
        () => ({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: connection.workspaceId,
          // Legacy connection records have no computer identity; the server rejects this.
          computerId: connection.computerId ?? "",
          // Protocol field retained for compatibility with the existing ready handshake.
          workerInstanceId: this.#runtimeInstanceId,
          startedAt: this.#startedAt,
          runningAgentIds: this.#readyRunningAgentIds(),
          daemonVersion: COFORGE_DAEMON_VERSION,
          computerVersion: this.computerVersion,
          ...this.#operatingSystem.current,
          recoveredRestartRequestIds: this.lifecycle.recoveredRestartRequestIds ?? [],
          recoveredUpgradeRequestIds: this.lifecycle.recoveredUpgradeRequestIds ?? [],
          capabilities: readyCapabilities(!!this.#migrations, !!this.#runtimeAuthControl),
        }),
        signal,
      );
      await this.#upgradeResults.report();
      await Promise.all(
        this.#readyRunningAgentIds().map((agentId) => this.#requestReminderSnapshot(agentId)),
      );
      this.#resyncAppConfigs();
      const { buffered, dropped } = publications.release();
      if (dropped > 0)
        logger.warn("Delivery notices held during start were dropped; the cloud resends them", {
          event: "daemon_runtime:notices_dropped",
          dropped,
        });
      this.#started = true;
      this.#activityPublisher.enable();
      this.#coldIdleSweep.start();
      this.#stalledRecoverySweep.start();
      this.#catalogFreshnessSweep.start();
      this.#machineStatus.start();
      // Kick off optional inventory before flushing buffered publications so immediate probes can
      // make progress while the first Agent inputs are delivered.
      const codeAgentReport = this.#codeAgentInventory.reportRuntimes(transport);
      await Promise.all(buffered.map((flush) => flush()));
      // Inventory is optional and may spawn several provider CLIs. Start accepting Agent
      // traffic as soon as the cloud handshake and recovery replay are complete; a slow probe
      // must never hold the first reply or a daemon restart hostage.
      void codeAgentReport
        .then((report) => this.#codeAgentInventory.refreshStaleCatalogs(report, transport))
        .catch(() => {});
    } catch (error) {
      this.#runtimeAuthControl?.stop();
      this.#runtimeAuthControl = undefined;
      this.#unsubscribeAll();
      this.#upgradeResults.stop();
      this.#started = false;
      // A connection left up keeps reporting this Computer online for a Workspace that never
      // started, so a failed start takes its transport down too.
      const stopError = await this.#replaceTransport();
      if (stopError !== undefined)
        logger.warn("Stopping the connection of a failed start failed", {
          event: "daemon_runtime:failed_start_stop_failed",
          error_code: diagnosticErrorCode(stopError),
        });
      throw error;
    }
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
        sessionReferences: this.#sessionReferences,
      },
      agentId,
      config,
      recovery,
      request,
    );
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
      stoppingAgents: this.#stoppingAgents,
      inputDrain: this.#inputDrain,
      currentActivityLaunches: this.#currentActivityLaunches,
      interruptIfBusy: (id: string, current: ActivityLaunch | undefined) =>
        this.#interruptIfBusy(id, current),
      activityPublisher: this.#activityPublisher,
      disposeLaunchObservations: (id: string) => this.#disposeLaunchObservations(id),
      revokeLocalLaunch: (id: string) => this.#revokeLocalLaunch(id),
      offlineResidency: this.#offlineResidency,
      stopCoordinator: this.#stopCoordinator,
      agentStops: this.#agentStops,
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
        sessionReferences: this.#sessionReferences,
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
    // A late trajectory flush must not mutate the replacement launch's Agent state.
    if (this.#currentActivityLaunches.get(agentId) !== launch) return;
    observeRuntimeEvent(
      this.#observationPorts,
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
    this.#assertOwnIntent({
      ...intent,
      computerId: intent.computerId || this.#connection.computerId,
    });
    if (intent.controlEpoch) {
      await this.#agentControl.start(intent);
      await this.#agentSessions.replay(intent.agentId);
      const runtime = this.#agentProcessManager.runtime(intent.agentId);
      if (!runtime) throw new Error("Agent managed launch did not complete");
      return runtime;
    }
    if (this.#agentControl.managed(intent.agentId))
      throw new Error("Agent requires a fenced Start");
    const stopping = this.#agentStops.get(intent.agentId);
    if (stopping) await stopping;
    return this.#startAgent(intent.agentId, runtimeConfigOf(intent), recoveryOf(intent), {
      sessionId: intent.sessionId,
      requestId: intent.requestId,
      previousLaunchId: intent.previousLaunchId,
      sessionMode: intent.sessionMode,
      resumePrompt: intent.resumePrompt,
      introductionPrompt: intent.introductionPrompt,
    });
  }

  async handleAgentWorkspaceReset(request: AgentWorkspaceResetRequest): Promise<void> {
    if (
      !this.#started ||
      this.#stopping ||
      request.workspaceId !== this.#connection.workspaceId ||
      request.computerId !== this.#connection.computerId
    )
      throw new Error("Agent control scope unavailable");
    await this.#agentControl.resetWorkspace(request);
  }

  async handleAgentStop(intent: AgentStopIntent): Promise<void> {
    this.#assertOwnIntent(intent);
    if (intent.provider !== undefined && intent.controlEpoch !== undefined) {
      await this.#agentControl.stop({
        protocolMajor: intent.protocolMajor,
        requestId: intent.requestId,
        workspaceId: intent.workspaceId,
        computerId: intent.computerId,
        agentId: intent.agentId,
        provider: intent.provider,
        epoch: intent.controlEpoch,
      });
      return;
    }
    if (this.#agentControl.managed(intent.agentId)) throw new Error("Agent requires a fenced Stop");
    await this.stopAgent(intent.agentId);
  }
  async handleAgentTurnInterrupt(intent: AgentTurnInterruptIntent): Promise<void> {
    this.#assertOwnIntent(intent);
    await interruptAgentTurn(
      {
        launch: (agentId) => this.#currentActivityLaunches.get(agentId),
        interrupt: (agentId, options) => this.#agentProcessManager.interruptTurn(agentId, options),
        publish: (agentId, launch, outcome) =>
          this.#activityPublisher.publish(
            agentId,
            launch,
            outcome === "restarted"
              ? this.#activity(
                  agentId,
                  AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
                  "info",
                  "Stopping this turn: restarting the runtime",
                )
              : this.#drafts.interrupted(agentId),
          ),
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
    this.#assertOwnIntent(probe);
    const launch = this.#currentActivityLaunches.get(probe.agentId);
    if (!launch) {
      logger.info("Activity probe received for an Agent that is not running", {
        event: "agent_activity_probe:not_running",
        request_id: probe.requestId,
        workspace_id: probe.workspaceId,
        computer_id: probe.computerId,
        agent_id: probe.agentId,
        probe_id: probe.probeId,
        outcome: "skipped",
      });
      return;
    }
    const unread = this.#messageAttention.unreadDeliveries(probe.agentId);
    const hold = this.#deliveryQueue.explicitHold(probe.agentId);
    if (unread.length && hold !== "fingerprint_fence") {
      logger.info("Activity probe answered for an Agent with unread messages", {
        event: "agent_activity_probe:pending_delivery",
        request_id: probe.requestId,
        workspace_id: probe.workspaceId,
        computer_id: probe.computerId,
        agent_id: probe.agentId,
        probe_id: probe.probeId,
        launch_id: launch.launchId,
        target_count: unread.length,
        message_count: unread.reduce((sum, target) => sum + target.count, 0),
        ...(hold ? { hold_reason: hold } : {}),
      });
      this.#activityPublisher.publish(probe.agentId, launch, {
        ...this.#activity(
          probe.agentId,
          AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
          "info",
          "Message received",
          { entries: [] },
        ),
        probeId: probe.probeId,
      });
      return;
    }
    const remembered = this.#activityPublisher.lastBusy(probe.agentId);
    if (launch.startup?.waiting) {
      this.#activityPublisher.publish(probe.agentId, launch, {
        ...this.#drafts.starting(probe.agentId),
        probeId: probe.probeId,
      });
      return;
    }
    if (remembered && remembered.launch === launch) {
      this.#activityPublisher.publish(probe.agentId, launch, {
        ...remembered.activity,
        probeId: probe.probeId,
        entries: [],
        isHeartbeat: false,
      });
      return;
    }
    this.#activityPublisher.publish(probe.agentId, launch, {
      ...this.#drafts.idle(probe.agentId),
      probeId: probe.probeId,
    });
  }

  async handleAgentMessage(message: AgentMessageDelivery): Promise<void> {
    this.#assertRunning();
    if (message.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (message.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent message targets another Workspace");
    if (isTrackedMention(message)) return this.#handleTrackedMention(message);
    if (this.#stoppingAgents.has(message.agentId))
      throw new Error(`Agent runtime is stopping: ${message.agentId}`);
    // A stalled provider is restarted for this message; arrivals meanwhile wait for that relaunch.
    if (this.#runnerHold === undefined) {
      const recovering = this.#runtimeRelease.isRecovering(message.agentId);
      const stalled = recovering ? undefined : this.#runtimeRelease.stalled(message.agentId);
      if (recovering || stalled) {
        this.#exitedDelivery.keepForNextLaunch(message.agentId, message);
        if (stalled) return this.#runtimeRelease.recoverStalled(message.agentId, stalled);
        return;
      }
    }
    if (this.#runnerHold === undefined && this.#sync.changed(message))
      return this.#sync.restart(message);
    const exited =
      this.#runnerHold === undefined &&
      !this.#agentProcessManager.session(message.agentId) &&
      !this.#agentLaunches.has(message.agentId);
    if (exited) return this.#exitedDelivery.deliver(message);
    // A wake launch that will present waiting deliveries is still in flight: join them as well,
    // rather than arriving as a second notice right after theirs. Only a wake: a recovery launch
    // drops what waits once its own notice is accepted, and that notice does not cover this one.
    if (
      this.#runnerHold === undefined &&
      !this.#agentProcessManager.session(message.agentId) &&
      this.#wakeLaunches.has(message.agentId) &&
      this.#deliveryQueue.hasQueued(message.agentId)
    ) {
      this.#exitedDelivery.keepForNextLaunch(message.agentId, message);
      return;
    }
    const delivery = this.#launchCustody.enqueueDelivery(message.agentId, message);
    // Runner hold: the delivery is queued, never rejected and never indexed. Attention indexing is
    // what wakes a turn, and the server's canonical read boundary only advances when the Agent
    // itself drains `check` - so a held delivery stays undelivered server-side and is re-fetched
    // after the restart. Nothing is acknowledged while the hold is in force.
    if (this.#runnerHold !== undefined) {
      void delivery.catch(() => {});
      logger.info("Agent delivery queued behind a runner hold", {
        event: "agent.message.delivery_held",
        agent_id: message.agentId,
        delivery_id: message.deliveryId,
        reason: this.#runnerHold.reason,
      });
      return;
    }
    if (this.#agentProcessManager.session(message.agentId))
      this.#inputDrain.ensure(message.agentId);
    // Otherwise a launch is in flight, and it drains the queue once its session is up.
    return delivery;
  }

  /**
   * A tracked @mention: told only to the running launch and session its envelope names, and ACKed
   * only once drained there (`MentionDeliveryTracker`). It never wakes an Agent, waits for a
   * launch or a pending server Start, or becomes `no_process`: with no running session it is
   * drained if already consumed and refused as `IDENTITY_UNKNOWN` otherwise, and the server
   * decides what happens next. A runner hold queues it unacknowledged like any delivery.
   */
  #handleTrackedMention(message: TrackedMentionDelivery): Promise<void> {
    const { agentId } = message;
    const refusal = this.#mentionDeliveries.admissionRefusal(message);
    if (refusal) return this.#mentionDeliveries.refuse(message, refusal);
    // A stalled provider being restarted is no session to tell: refused as unknown, the server
    // keeps the mention pending and issues it again for the relaunch's session report.
    if (
      this.#runnerHold === undefined &&
      (this.#stoppingAgents.has(agentId) ||
        this.#runtimeRelease.isRecovering(agentId) ||
        !this.#agentProcessManager.session(agentId))
    ) {
      this.#mentionDeliveries.drop(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN);
      return Promise.resolve();
    }
    const delivery = this.#launchCustody.enqueueDelivery(agentId, message);
    if (this.#runnerHold !== undefined) {
      void delivery.catch(() => {});
      return Promise.resolve();
    }
    this.#inputDrain.ensure(agentId);
    return delivery;
  }

  /** The launch and native session a tracked mention may name: the ones last reported for this
   * Agent, while that launch is the one running. */
  #runningMentionIdentity(agentId: string): RunningMentionIdentity | undefined {
    if (!this.#agentProcessManager.session(agentId)) return undefined;
    const reported = this.#reportedSessions.get(agentId);
    const launch = this.#currentActivityLaunches.get(agentId);
    return reported && launch?.launchId === reported.launchId ? reported : undefined;
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

  /** Relaunches an exited Agent for a message; a failure starts or extends the wake cooldown. A
   * successful launch presents whatever `AgentDeliveryQueue` holds for it as one notice. */
  #wakeAgent(agentId: string, restart: AgentRestartConfig): Promise<AgentRuntime> {
    const launch = this.#startAgent(agentId, restart.config, undefined, {
      sessionId: restart.sessionId,
    });
    this.#wakeLaunches.add(agentId);
    void launch
      .catch(() => this.#wakeLaunchFailures.recordFailure(agentId))
      .finally(() => this.#wakeLaunches.delete(agentId));
    return launch;
  }

  /** Drops an Agent's local state for channels it can no longer read: waiting deliveries (each
   * acknowledged, so a rejoin does not bring them back on `ready`) and the pending attention of
   * those channels and their threads. */
  handleAgentInboxPurge(purge: AgentInboxPurge): void {
    this.#assertRunning();
    if (purge.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent inbox purge targets another Workspace");
    const conversations = new Set(purge.conversationIds);
    const session = this.#agentProcessManager.session(purge.agentId);
    for (const conversationId of conversations)
      void session?.purgeConversation?.(conversationId).catch((error) => {
        logger.warning("Memory conversation cleanup failed", {
          event: "agent.inbox.purge_cleanup_failed",
          agent_id: purge.agentId,
          error_code: diagnosticErrorName(error),
        });
      });
    let dropped = 0;
    const queue = this.#inputDrain.get(purge.agentId);
    if (queue)
      queue.items = queue.items.filter((item) => {
        if (item.kind !== "delivery" || !conversations.has(item.message.conversationId))
          return true;
        // Taken and dropped: acknowledged, so the server does not bring it back after a rejoin. A
        // tracked mention is never ACKed untold: the Agent will not be told it, so it is rejected.
        if (
          !this.#mentionDeliveries.drop(
            item.message,
            MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
          )
        )
          this.#launchCustody.acknowledge(item.message);
        item.completion.resolve();
        dropped++;
        return false;
      });
    dropped += this.#deliveryQueue.discardConversations(purge.agentId, conversations).length;
    this.#messageAttention.clearTargets(purge.agentId, purge.targets);
    logger.info("Agent inbox purged for channels it can no longer read", {
      event: "agent.inbox.purged",
      agent_id: purge.agentId,
      reason: purge.reason,
      conversation_count: conversations.size,
      dropped_delivery_count: dropped,
    });
  }

  stopAgent(agentId: string): Promise<void> {
    const existingStop = this.#agentStops.get(agentId);
    if (existingStop) return existingStop;
    // Close this Agent's launch gate and local capabilities before the first await.
    this.#stoppingAgents.add(agentId);
    this.#sessionReferences.delete(agentId);
    this.#inputDrain.close(agentId, new Error(`Agent runtime is stopping: ${agentId}`));
    // Invalidate acceptance before disposal: a late native reply cannot acknowledge a cancelled
    // delivery or attach its attention to the replacement session.
    this.#messageAttention.clearAgent(agentId, { cancelNotices: true });
    void this.#mentionDeliveries.cancelAgent(agentId);
    this.#agentProcessManager.session(agentId)?.cancelPendingNotices?.();
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    activityLaunch?.startup?.dispose();
    if (activityLaunch) activityLaunch.stopping = true;
    this.#interruptIfBusy(agentId, activityLaunch);
    this.#activityPublisher.forgetBusy(agentId);
    this.#disposeLaunchObservations(agentId);
    this.#revokeLocalLaunch(agentId);
    const stopping = this.#stopCoordinator
      .stopAgent(agentId)
      .catch((error) => {
        if (activityLaunch)
          this.#activityPublisher.publish(
            agentId,
            activityLaunch,
            this.#drafts.runtimeError(
              agentId,
              stopFailureMessage(this.#cleanupUnconfirmed(agentId, error)),
            ),
          );
        throw error;
      })
      .finally(() => {
        this.#agentStops.delete(agentId);
        if (!this.#agentProcessManager.isStopping(agentId)) this.#stoppingAgents.delete(agentId);
      });
    this.#agentStops.set(agentId, stopping);
    return stopping;
  }

  /** Forgets one ended launch's observation state without affecting another Agent. */
  #disposeLaunchObservations(agentId: string): void {
    this.#currentActivityLaunches.get(agentId)?.stalled?.dispose(agentId);
    this.#phaseBookkeeping.dispose(agentId);
    this.#usageReport.forget(agentId);
    this.#fastModeWarned.delete(agentId);
  }

  #readyRunningAgentIds(): string[] {
    return this.#agentProcessManager
      .runningAgentIds()
      .filter(
        (agentId) =>
          !this.#agentLaunches.has(agentId) &&
          !this.#stoppingAgents.has(agentId) &&
          !this.#agentProcessManager.isStopping(agentId),
      );
  }

  /** Revokes the Agent's local context and proxy token; defaults to whatever is currently issued. */
  #revokeLocalLaunch(
    agentId: string,
    context = this.#agentContexts.get(agentId),
    proxyToken = this.#agentProxyTokens.get(agentId),
  ): void {
    if (context && this.#agentContexts.get(agentId) === context)
      this.#agentContexts.delete(agentId);
    if (proxyToken && this.#agentProxyTokens.get(agentId) === proxyToken)
      this.#agentProxyTokens.delete(agentId);
    if (proxyToken) this.#agentProxy?.revoke(proxyToken);
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

  /** Narrates a daemon-initiated cold start: a stored session found unusable, or one recycled. */
  #narrateUnavailable(
    agentId: string,
    launch: ActivityLaunch,
    { detail, entryText }: { detail: string; entryText?: string },
  ): void {
    this.#activityPublisher.publish(
      agentId,
      launch,
      this.#activity(
        agentId,
        AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE,
        "info",
        detail,
        entryText ? { entries: [{ kind: "text", text: entryText }] } : {},
      ),
    );
  }

  /** Attempts delivery of everything just released from an explicit or busy-gated hold, as one
   * coalesced notice — never blocking the caller on it. Shared by ordinary turn-end draining and
   * the runtime-error delivery backoff. */
  #flushHeldDeliveries(agentId: string, held: AgentMessageDelivery[]): void {
    void this.#messageAttention.flush(agentId, held).catch((error: unknown) => {
      logger.warn("Held Agent deliveries were not accepted", {
        event: "agent.delivery_queue.flush_rejected",
        agent_id: agentId,
        held_count: held.length,
        already_acknowledged: true,
        error_code: diagnosticErrorName(error),
      });
    });
  }

  /** Reports runtime_interrupted when a requested stop/restart cuts a busy turn.
   * Must run before `forgetBusy`, which erases the busy evidence. */
  #interruptIfBusy(agentId: string, activityLaunch: ActivityLaunch | undefined): void {
    if (!activityLaunch) return;
    const busy = this.#activityPublisher.lastBusy(agentId);
    if (busy && busy.launch === activityLaunch)
      this.#activityPublisher.publish(agentId, activityLaunch, this.#drafts.interrupted(agentId));
  }

  /**
   * Shows a turn that ended without an error, as the reference client does: still working while
   * tasks it started run in the background, otherwise Idle, which ends the Agent's working
   * stretch (`SystemCleaner.onAgentWorkingToIdle`).
   */
  #showQuietTurn(
    agentId: string,
    launch: ActivityLaunch,
    publish: (agentId: string, launch: ActivityLaunch, activity: ActivityDraft) => void,
  ): void {
    const waiting = launch.backgroundTasks?.quietDetail();
    publish(agentId, launch, this.#drafts.quietTurn(agentId, waiting));
    if (!waiting) this.systemCleaner.onAgentWorkingToIdle(agentId);
  }

  /** Restore observation and delivery gating only; this is no proof of a turn outcome. */
  #reconcileIdleTurn(agentId: string, launch: ActivityLaunch): boolean {
    if (
      this.#currentActivityLaunches.get(agentId) !== launch ||
      this.#agentProcessManager.session(agentId)?.hasLiveTurn !== false
    )
      return false;
    // A turn already showing its wait for background tasks stays as it is: the heartbeat keeps
    // that warm until a task ends.
    const waiting = launch.backgroundTasks?.quietDetail();
    const shown = this.#activityPublisher.lastBusy(agentId)?.activity;
    if (
      waiting &&
      shown?.detailKind === AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY &&
      shown.detail === waiting
    )
      return false;
    // Preserve output accepted while the turn was live before publishing its final Idle.
    // Otherwise the pending trajectory timer could publish it after Idle and rearm Busy.
    launch.trajectory?.flush();
    launch.stalled?.finish(agentId);
    this.#phaseBookkeeping.dispose(agentId);
    if (this.#isWorking(agentId)) {
      this.#showQuietTurn(agentId, launch, (id, source, activity) =>
        this.#activityPublisher.publish(id, source, activity),
      );
      this.#releaseTurnEndHolds(agentId);
    }
    return true;
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

  /** Presents what was kept across an exit or a runtime's end, as at idle. */
  #releaseSurvivingHolds(agentId: string): void {
    this.#launchCustody.flushSurvivingDeliveryQueue(agentId);
    this.#inboxCoordinator.releaseHeldAppItems(agentId);
    this.#inboxCoordinator.releaseFallbackNotices(agentId);
  }

  /** Whether the Agent is mid-turn, by its last busy Activity or a notice just written. */
  #isWorking(agentId: string): boolean {
    return (
      this.#activityPublisher.lastBusy(agentId) !== undefined || this.#deliveryQueue.isBusy(agentId)
    );
  }

  #releaseTurnEndHolds(agentId: string): void {
    const held = this.#deliveryQueue.idle(agentId);
    if (held.length) this.#flushHeldDeliveries(agentId, held);
    // Flush first: notifying marks busy synchronously, so app items re-hold for the next
    // turn rather than racing the notice that just started it.
    this.#inboxCoordinator.releaseHeldAppItems(agentId);
    this.#inboxCoordinator.releaseFallbackNotices(agentId);
  }

  #sendAgentStatus(agentId: string, status: "active" | "inactive"): void {
    sendAgentStatus(this.#statusReportPorts, agentId, status);
  }

  #cleanupUnconfirmed(agentId: string, error: unknown): boolean {
    return cleanupUnconfirmed(agentId, error, (id) => this.#agentProcessManager.isStopping(id));
  }

  /** The error Activity for a launch that did not start: its typed reason rides `runtimeError`
   * (class `LauncherError`) beside the sentence that explains it. */
  #launchFailureActivity(
    agentId: string,
    provider: RuntimeProvider,
    error: unknown,
  ): ActivityDraft {
    const draft = launchFailureDraft(provider, error, this.#cleanupUnconfirmed(agentId, error));
    return this.#drafts.runtimeError(agentId, draft.detail, draft.runtimeError);
  }

  async #revokeAgentApiKey(agentId: string, agentApiKey: string | undefined): Promise<void> {
    await revokeAgentApiKey(this.#transport, this.#agentApiKeys, agentId, agentApiKey);
  }

  async agentMessage(
    context: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!this.#transport.agentMessage)
      throw new AgentPreflightError("daemon connection is not connected", "DAEMON_NOT_CONNECTED");
    if (!isAgentApiKey(agentApiKey))
      throw new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING");
    logger.info("Agent message operation received", {
      event: "agent.message.operation",
      agent_id: agentId,
      operation: request.operation,
      target: request.target ?? "*",
    });
    // A spelling a read has already mapped to its canonical target shares that target's state.
    const target = request.target
      ? this.#messageAttention.resolveTarget(
          agentId,
          await this.#canonicalAgentMessageTarget(agentId, request.target, agentApiKey),
        )
      : undefined;
    return this.#messageOperations.handle(agentId, request, target, agentApiKey);
  }

  /**
   * `coforge version`'s local-only query: answered entirely from this already-running
   * Workspace child, never forwarded to Web/backend. `computerVersion` is the Computer executable
   * version this Daemon was launched with (`runDaemon(args, computerVersion)`, `packages/computer/
   * src/main.ts`'s `__workspace-daemon` dispatch); it bundles both the Computer and Daemon package
   * roles into one executable, so this is not a second installation.
   */
  async version(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentVersionResponse> {
    this.#authorizedAgent(context, agentApiKey);
    return {
      ok: true,
      daemonVersion: COFORGE_DAEMON_VERSION,
      ...(this.computerVersion ? { computerVersion: this.computerVersion } : {}),
      daemonPid: process.pid,
      startedAt: this.#startedAt,
    };
  }

  memoryFence(agentId: string): string | undefined {
    return (
      this.#agentProcessManager.runtime(agentId)?.config.toolProfile ??
      this.#agentProcessManager.restartConfig(agentId)?.config.toolProfile
    );
  }

  /** Dispatches one task command to the cloud task route over its HTTPS path. The body is the
   * plain command — the route derives its principal from the Agent API key, so no envelope
   * travels with it. */
  async agentTask(context: string, command: TaskCommand, agentApiKey: string): Promise<TaskResult> {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    if (!this.#transport.agentTask) throw new Error("daemon connection is not connected");
    if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
    const freshnessAction = command.operation === "claim" || command.operation === "update";
    if (freshnessAction && command.target) {
      const held = await heldTaskResult(
        {
          messageAttention: this.#messageAttention,
          agentMessage: this.#transport.agentMessage?.bind(this.#transport),
          workspaceId: this.#connection.workspaceId,
        },
        agentId,
        command,
        command.target,
        agentApiKey,
      );
      if (held) return held;
    }
    return this.#transport.agentTask({ ...command }, agentApiKey);
  }

  #canonicalAgentMessageTarget(
    agentId: string,
    target: string,
    agentApiKey: string,
  ): Promise<string> {
    return canonicalThreadTarget(target, (parent, anchor) =>
      this.#transport.agentMessage!(
        {
          idempotencyKey: crypto.randomUUID(),
          agentId,
          workspaceId: this.#connection.workspaceId,
          operation: "read",
          target: parent,
          around: anchor,
          limit: 1,
        },
        agentApiKey,
      ),
    );
  }

  async mintAppItem(agentId: string, input: MintAppItem) {
    return this.#inboxCoordinator.mintAppItem(agentId, input);
  }

  async reminder(context: string, request: LocalReminderRequest, agentApiKey: string) {
    const agentId = this.#authorizedAgent(context, agentApiKey);
    if (request.operation === "ack" || request.operation === "dismiss") {
      const accepted = await this.#reminders.acknowledge(
        agentId,
        request.reminderId!,
        request.revision!,
      );
      const removed = await this.#inboxCoordinator.removeAppItem(
        agentId,
        reminderDueItemId(request.reminderId!, request.revision!),
      );
      if (!accepted) {
        // Neither the receipt file nor this daemon knows the receipt (the file was lost or is
        // unreadable, and the daemon has restarted since), but the Agent was shown this exact
        // revision: its inbox item proves the delivery. Clear it rather than leave an item nothing
        // can ever acknowledge; the cloud already refuses to fire this revision again.
        if (!removed)
          return { accepted: false, reason: "reminder receipt not found for exact revision" };
        logger.info("Reminder acknowledged from its inbox item without a local receipt", {
          event: "reminder.ack_without_receipt",
          outcome: "ok",
          agent_id: agentId,
          reminder_id: request.reminderId,
          reminder_version: request.revision,
        });
      }
      return { accepted: true, reminderId: request.reminderId, revision: request.revision };
    }
    if (!this.#transport.agentReminder) throw new Error("Agent reminder transport is unavailable");
    const { context: _context, revision: _revision, ...fields } = request;
    return this.#transport.agentReminder(
      {
        ...fields,
        workspaceId: this.#connection.workspaceId,
        computerId: this.#connection.computerId,
        agentId,
      } as AgentReminderOperationRequest,
      agentApiKey,
    );
  }

  async #acceptReminderDue(job: ReminderJob, late: boolean): Promise<boolean> {
    const item = await (
      await this.#inboxCoordinator.appInbox(job.ownerAgentId)
    ).upsert({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: job.reminderId, revision: String(job.version) },
      title: reminderAppInboxPreview(job.title),
      summary: reminderAppInboxSummary(job, late),
    });
    return this.#inboxCoordinator.notifyAppItem(job.ownerAgentId, item.itemId);
  }

  /** A new connection: asks again for every running Agent's App config. */
  #resyncAppConfigs(): void {
    this.#appConfigs.connected();
    // A launch in progress asked on the old connection, whose answer is now dropped.
    for (const agentId of new Set([...this.#readyRunningAgentIds(), ...this.#agentLaunches.keys()]))
      this.#requestAppConfigSnapshot(agentId);
  }

  /** Asks once per connection for the Agent's App config; the cloud resends on the next one. */
  #requestAppConfigSnapshot(agentId: string): void {
    if (!this.#transport.requestAppConfigSnapshot) return;
    void this.#appConfigs.request(agentId).catch((error: unknown) =>
      logger.warn("Asking for an Agent's App config failed; the next connection asks again", {
        event: "agent_app_config:snapshot_failed",
        agent_id: agentId,
        error_code: diagnosticErrorName(error),
      }),
    );
  }

  async #requestReminderSnapshot(agentId: string): Promise<void> {
    if (!this.#transport.requestSnapshot) return;
    const sync: ReminderSync = await this.#transport.requestSnapshot({
      ...this.#env(),
      agentId,
    });
    await this.#reminders.apply(sync);
  }

  async inbox(context: string, request: LocalInboxRequest): Promise<InboxResponse> {
    return this.#inboxCoordinator.inbox(context, request);
  }

  async drainAppInboxNotices(agentId: string): Promise<void> {
    return this.#inboxCoordinator.drainAppInboxNotices(agentId);
  }

  #agentIdForContext(context: string): string {
    return agentIdForContext(this.#agentContexts, context);
  }

  #contextFor(agentId: string): string {
    return contextFor(this.#agentContexts, agentId);
  }

  issueAgentContext(agentId: string, context: string = crypto.randomUUID()): string {
    this.#assertRunning();
    this.#agentContexts.set(agentId, context);
    void this.#requestReminderSnapshot(agentId).catch(() => {});
    return context;
  }

  /**
   * Stops admitting new Agent turns and reports which Agents are still busy. Idempotent: a repeat
   * call only re-reads the busy set, which is what the restart's quiescence poll relies on.
   */
  holdRunners(reason: RunnerHoldReason): BusyAgentReport[] {
    if (this.#runnerHold === undefined)
      logger.info("Runner hold engaged", { event: "daemon.runner_hold.engaged", reason });
    this.#runnerHold = { reason, renewedAtMs: Date.now() };
    return this.busyAgents();
  }

  /** Lifts the hold and resumes every delivery queued behind it, in arrival order. */
  releaseRunners(): BusyAgentReport[] {
    if (this.#runnerHold !== undefined)
      logger.info("Runner hold released", {
        event: "daemon.runner_hold.released",
        reason: this.#runnerHold.reason,
      });
    this.#runnerHold = undefined;
    dropHeldMentionsWithoutSession({
      inputDrain: this.#inputDrain,
      hasSession: (agentId) => Boolean(this.#agentProcessManager.session(agentId)),
      hasLaunch: (agentId) => this.#agentLaunches.has(agentId),
      dropMention: (message) =>
        this.#mentionDeliveries.drop(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN),
    });
    // Copied deliberately: a finishing drain deletes its own entry mid-iteration.
    const queued = [...this.#inputDrain.entries()].map(([agentId]) => agentId);
    for (const agentId of queued) this.#inputDrain.ensure(agentId);
    return this.busyAgents();
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
    // Close every local capability synchronously before any shutdown await.
    this.#stopping = true;
    this.#runtimeAuthControl?.stop();
    this.#runtimeAuthControl = undefined;
    this.#started = false;
    this.#coldIdleSweep.stop();
    this.#stalledRecoverySweep.stop();
    this.#catalogFreshnessSweep.stop();
    this.#machineStatus.stop();
    this.#activityPublisher.disable();
    for (const [agentId, launch] of this.#currentActivityLaunches) {
      launch.startup?.dispose();
      launch.stalled?.dispose(agentId);
    }
    this.#phaseBookkeeping.disposeAll();
    this.#runtimeErrorHold.disposeAll();
    this.#upgradeResults.stop();
    this.#usageReport.clear();
    this.#fastModeWarned.clear();
    for (const agentId of new Set([
      ...[...this.#inputDrain.entries()].map(([agentId]) => agentId),
      ...this.#agentLaunches.keys(),
      ...this.#agentProcessManager.activeAgentIds(),
    ])) {
      this.#stoppingAgents.add(agentId);
      this.#inputDrain.close(agentId, new Error("daemon runtime is stopping"));
      this.#messageAttention.clearAgent(agentId, { cancelNotices: true });
      void this.#mentionDeliveries.cancelAgent(agentId);
      this.#agentProcessManager.session(agentId)?.cancelPendingNotices?.();
    }
    this.#unsubscribeAll();
    // A start still waiting for its first cloud connection would otherwise hold this stop up for
    // as long as the cloud stays unreachable.
    this.#startAbort?.abort(new DaemonConnectionStoppedError());
    this.#reminders.stop();
    this.systemCleaner.clear();
    // Each attempt is leased again on the next ready, and its run picks up from the server's state.
    this.#migrationsClosed = this.#migrations?.close();
    for (const token of this.#agentProxyTokens.values()) this.#agentProxy?.revoke(token);
    this.#agentProxyTokens.clear();
    this.#agentContexts.clear();
    this.#stopPromise = this.#stop(shutdownReason).finally(() => {
      this.#stopPromise = undefined;
      this.#stopping = false;
    });
    return this.#stopPromise;
  }

  /**
   * Waits for the reminder work that was already running when `stop()` closed the scheduler: a fire
   * request awaiting the cloud, a wake, and the receipt writes they lead to. A receipt is the
   * re-fire fence, so a write that has begun must land before the state directory is released
   * (a caller that removes it right after `stop()` would otherwise see the write recreate it).
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
        this.#reminders.awaitIdle().then(() => "settled" as const),
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
   * Waits, on the same bound as `#settleReminders`, for the migration runs `stop()` aborted: a
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

  async #stop(shutdownReason: DaemonShutdownReason): Promise<void> {
    const piChat = this.#piChat;
    this.#piChat = undefined;
    const piChatClosed = piChat?.close();
    // No retry timer may outlive this daemon instance: a launch that was mid-cooldown left a
    // "starting" record behind, which the next instance repairs and recovers (`recover()`).
    this.#agentControl.dispose();
    const activeAgentIds = this.#agentProcessManager.activeAgentIds();
    const sessions = activeAgentIds.map((id) => ({
      id,
      session: this.#agentProcessManager.session(id),
      launchId: this.#currentActivityLaunches.get(id)?.launchId,
    }));
    let shutdownError: unknown;
    // Start cleanup before awaiting any launch or input that cleanup itself must release.
    try {
      await this.#agentProcessManager.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    if (this.#startPromise) await Promise.allSettled([this.#startPromise]);
    await Promise.allSettled(this.#agentLaunches.values());
    await Promise.allSettled(this.#inputDrain.drains());
    try {
      // Reconcile sessions whose creation finished during shutdown, including failed cleanup.
      for (const agentId of this.#stoppingAgents)
        if (this.#agentProcessManager.isStopping(agentId)) throw new AgentProcessCleanupError();
      await this.#agentProcessManager.shutdown();
      this.#stoppingAgents.clear();
      for (const { id, session, launchId } of sessions) {
        if (launchId)
          await this.#agentControl.stopped(id, launchId, await session?.readSessionIdentity?.());
        await this.#agentSessions.replay(id);
      }
    } catch (error) {
      shutdownError ??= error;
    }
    for (const agentId of activeAgentIds) this.#sendAgentStatus(agentId, "inactive");
    this.#currentActivityLaunches.clear();
    this.#sessionReferences.clear();
    // Every Agent process is down now. Each key they were using gets its one revoke request,
    // best-effort: a failure is logged, never fails teardown, and is not retried. The shutdown
    // notice goes out alongside, never ahead of them: its own bound must not push the revokes
    // past the service manager's grace period. The transport bounds it and never throws. Reminder
    // work already running settles alongside too, on the same bound, before the transport closes.
    await Promise.all([
      this.#settleReminders(),
      piChatClosed,
      this.#settleMigrations(),
      this.#connection.computerId
        ? this.#transport.sendShutdownNotice?.({
            ...this.#env(),
            workerInstanceId: this.#runtimeInstanceId,
            reason: shutdownReason,
          })
        : undefined,
      ...[...this.#agentApiKeys].map(([agentId, agentApiKey]) =>
        this.#revokeAgentApiKey(agentId, agentApiKey).catch((error) => {
          logAgentApiKeyRevokeFailed(agentId, error);
        }),
      ),
    ]);
    const transportError = await this.#replaceTransport();
    shutdownError ??= transportError;
    // Every write already committed; closing releases the WAL and the file handles.
    this.#consumedSeqs.close();
    if (shutdownError !== undefined) throw shutdownError;
  }
}

export type { CodeAgentProviderFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
export type { BusyAgentReport };
