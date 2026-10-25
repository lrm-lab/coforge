import {
  AGENT_RUNTIME_EVENT_TYPE,
  AgentProcessCleanupError,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type UsageSnapshot,
} from "@lrm/coforge-anvil";
import { isMemoryAgentRuntime } from "@coforge/agent";
import { mkdirSync } from "node:fs";
import { readOperatingSystem } from "#src/platform/operating-system";
import { FileConversationSessionStore } from "#src/persistence/conversation-session-store";
import { escapePathIdentity } from "#src/persistence/path-scope";
import { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";
import type { ReplyIntentTracker } from "./reply-intent-tracker";
import { PhaseTracker } from "#src/agent-runtime/phase-tracker";
import {
  inferredCompactionFinish,
  TURN_ACTIVITY_EVENT_TYPES,
  PHASE_EDGES,
  RUNTIME_PHASES,
  type CompactionInference,
  type PhaseActivity,
  type RuntimePhase,
} from "#src/agent-runtime/runtime-phases";
import {
  type RuntimeErrorClassFence,
  runtimeErrorRecoverySignal,
} from "#src/agent-runtime/runtime-error-recovery";
import { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import {
  endsStalledTurn,
  StalledTurnTracker,
  stalledTurnNotice,
  stalledTurnObservation,
  stalledTurnSilenceMs,
} from "./stalled-turn-indicator";
import { interruptAgentTurn } from "./turn-interrupt";
import { heldTaskResult } from "./held-task-result";
import type { AgentProxy, LaunchRequest, SessionMode } from "./runtime-launch-types";
import {
  OutstandingBackgroundTasks,
  subagentProgressDetail,
} from "#src/agent-runtime/subagent-progress-activity";
import {
  buildRuntimeErrorActivity,
  buildRuntimeErrorFenceActivity,
  buildRuntimeCrashedActivity,
  buildRuntimeReconnectingActivity,
  type RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import { scrubRuntimeErrorText } from "@lrm/coforge-anvil";
import { classifyRuntimeError } from "#src/agent-runtime/runtime-error-classification";
import {
  AgentProcessManager,
  type CodeAgentProviderFactory,
  type AgentRestartConfig,
  type AgentRuntime,
} from "#src/agent-runtime/agent-process-manager";
import { resolveLaunchIdentity, type SessionReference } from "./launch-identity";
import { runtimeDisplayName, sessionInvalidateActivityText } from "./session-invalidate-activity";
import { fastModeUnavailableDetail } from "./fast-mode-activity";
import {
  recoveryHasContent,
  queueHasInputContent,
  recoveryOf,
  runtimeConfigOf,
  type AgentInput,
  type AgentInputCompletion,
  type AgentInputQueue,
  type AgentRecoveryContext,
} from "./runtime-launch-intent";
import {
  runtimeFailureDiagnostic,
  safeRuntimeActivityMessage,
  validUsageWindow,
} from "./runtime-activity-text";
import { parseAssignedSkillPacks } from "#src/code-agent/assigned-skills";
import {
  AgentAuthorizationError,
  launchFailureActivity,
  launchFailureLogFields,
} from "#src/agent-runtime/launch-failure";
import { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import {
  AgentStartup,
  AGENT_STARTUP_TIMEOUT_MS,
  agentStartupInput,
} from "#src/agent-runtime/agent-startup";
import { agentRuntimeContextEnvironment } from "#src/code-agent/environment";
import { createAgentDesktopHolds } from "#src/agent-runtime/agent-desktop";
import { toolStartActivity } from "#src/code-agent/tool-activity";
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
} from "#src/connection/daemon-connection";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "#src/connection/shutdown-notice-timeout";
import { DaemonConnectionStoppedError } from "#src/connection/daemon-connection-stopped-error";
import { HeldPublications } from "#src/connection/held-publications";
import {
  type DaemonConnectRejectionReason,
  WORKSPACE_PROTOCOL_MAJOR,
  type DaemonShutdownReason,
  type RunnerHoldReason,
  AGENT_MESSAGE_REJECT_METHOD,
  MENTION_DELIVERY_TERMINAL_CODES,
  AGENT_ACTIVITY_DETAIL_KIND,
  type AgentActivity,
  type AgentSessionInvalidate,
  type AgentSessionInvalidateReason,
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
  AGENT_SERVICE_TIER_OBSERVED,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type UsageScanResponse,
  CLEANER_APP_ID,
  type AgentReminderOperationRequest,
  type LocalReminderRequest,
  type ReminderJob,
  type ReminderSync,
  type TaskCommand,
  type TaskResult,
  parseUpgradeErrorCode,
  type AgentWorkspaceDeleteRequest,
  type AgentWorkspaceDeleteResult,
  type AgentContextScanRequest,
  type AgentContextScanResponse,
  AGENT_CONTEXT_SCAN_STATUS,
  thrownMessage,
} from "@lrm/coforge-sdk/internal";
import { agentsDirectory, agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import { AgentMigrationBucketClient } from "#src/connection/agent-migration-bucket-client";
import { usageScanFailure, usageScanReading, usageScanResult } from "./usage-scan-response";
import {
  agentContextReportOutcome,
  agentContextScanFailure,
  agentContextScanResponse,
  type AgentContextScanOutcome,
} from "./agent-context-scan-response";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentRuntimeState } from "#src/agent-runtime/agent-runtime-state";
import { MemoryAgentRuntimeStateStore } from "#src/persistence/memory-agent-runtime-state-store";
import { AgentWorkspaceQueries } from "./agent-workspace-queries";
import { deleteAgentWorkspaceFiles } from "#src/agent-runtime/agent-workspace-files";
import { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { ProviderProgress } from "./stalled-recovery";
import { ColdIdleSweep } from "./cold-idle-sweep";
import { RuntimeRelease } from "./runtime-release";
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
  isBusyActivityDetailKind,
  type PublishedActivityLaunch,
} from "./agent-activity-publisher";
import { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import { AgentOfflineResidency } from "./agent-offline-residency";
import { AgentExitedDelivery } from "./agent-exited-delivery";
import { AgentUsageReport } from "./agent-usage-report";
import {
  isTrackedMention,
  MentionDeliveryTracker,
  type RunningMentionIdentity,
  type TrackedMentionDelivery,
} from "./mention-delivery-tracker";
import { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";
import { AgentAppInbox, type MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import { reminderDueItemId } from "#src/agent-app-inbox/registry";
import { SystemCleaner, type SystemCleanerOptions } from "#src/system-cleaner/system-cleaner";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import { AgentPreflightError } from "./agent-preflight-error";
import { shutdownReasonForHold, type RunnerHold } from "./shutdown-reason";
import { CodeAgentInventorySync, type CodeAgentDiscovery } from "./code-agent-inventory-sync";
import { RuntimeAuthReporter } from "./runtime-auth-reporter";
import { subscribeProviderScans } from "./provider-scan-handlers";
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
import { FileReminderReceiptStore } from "#src/persistence/reminder-receipt-store";
import { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import {
  logAgentActivityProbeFailure,
  logAgentApiKeyRevokeFailed,
  logAgentOperationFailure,
  logAgentStartFailure,
} from "./agent-failure-logs";
import { acceptAppRegistrationNotice } from "#src/agent-app-inbox/app-registration-notice";
import { diagnosticErrorCode, diagnosticErrorName } from "@lrm/coforge-sdk/internal";
import type { AgentVersionResponse } from "@lrm/coforge-sdk/agent";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Per-provider reading deadline supplied by a runtime usage scan. */
export const USAGE_SCAN_READ_TIMEOUT_MS = 10_000;

const NOT_RUNNING = "daemon runtime is not running";
const CLEANUP_UNCONFIRMED =
  "Agent process cleanup could not be confirmed. Replacement launch is blocked.";

type ActivityLaunch = PublishedActivityLaunch & {
  startup?: AgentStartup;
  trajectory?: Pick<ActivityTrajectory, "flush" | "dispose">;
  /** When the provider last reported anything (`stalled-recovery.ts`). */
  progress?: ProviderProgress;
  /** The launch's open tool calls, and the outcome each one's end reports. */
  toolCalls?: ToolCallLedger;
  /** The busy turn's silence clock: one visible stalled notice per turn. */
  stalled?: StalledTurnTracker;
  /** Reply intents this launch announced; a turn interrupt clears them. */
  replyIntents?: ReplyIntentTracker;
  backgroundTasks?: OutstandingBackgroundTasks;
  // The most recent `error` event not yet resolved by a `completed` event, if any (cleared on
  // `completed`). Read by the process-exit handler to decide `runtime_crashed` vs `idle` wording
  // — `AgentSession.onExit` itself carries no exit code or signal, so this is the only fact the
  // core has for it (see agent-runtime/runtime-error-activity.ts).
  crashDetail?: RuntimeErrorEvent;
  runtimeErrorClassFence?: RuntimeErrorClassFence;
  /** Set when a runtime error took this launch's Agent offline (`#takeAgentOffline`): the exit
   * handler republishes this Activity — never a bare `runtime_crashed` — a launch that then
   * fails reports it instead of a generic launch failure, and a delivery to the offline Agent is
   * kept (queued and ACKed) with this Activity restated. */
  offlineError?: ReturnType<typeof buildRuntimeErrorActivity>;
};

function generateRuntimeInstanceId(): string {
  return crypto.randomUUID();
}

/** A daemon-owned resident runtime for one supervised Workspace. */
export class DaemonRuntime {
  readonly #connection: DaemonConfig;
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
    acknowledgeCustody: (message) => this.#acknowledgeCustody(message),
    restartConfig: (agentId) => this.#agentProcessManager.restartConfig(agentId),
    startPending: (agentId) => this.#agentControl.startPending(agentId),
    hasQueued: (agentId) => this.#deliveryQueue.hasQueued(agentId),
    queueForNextLaunch: (agentId, m) => this.#deliveryQueue.enqueue(agentId, m),
    wakeBlockedUntil: (agentId) =>
      this.#wakeLaunchFailures.isBlocked(agentId)
        ? this.#wakeLaunchFailures.blockedUntil(agentId)
        : undefined,
    enqueueInputDelivery: (agentId, message) => this.#enqueueDelivery(agentId, message),
    wakeAgent: (agentId, restart) => this.#wakeAgent(agentId, restart),
    offline: {
      has: (agentId) => this.#offlineResidency.has(agentId),
      restate: (agentId) => this.#offlineResidency.restate(agentId),
    },
    queuedInputDeliveries: (agentId) =>
      this.#agentInputQueues
        .get(agentId)
        ?.items.flatMap((item) => (item.kind === "delivery" ? [item.message] : [])) ?? [],
    drainInputDeliveries: (agentId) => {
      const queue = this.#agentInputQueues.get(agentId);
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
    closeAgentInputQueue: (agentId, error) => this.#closeAgentInputQueue(agentId, error),
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
  /** Ends a live process without a stopped/crashed Activity, for a stalled provider's restart or
   * a cold idle stop; the Agent stays active and wakeable. */
  readonly #runtimeRelease = new RuntimeRelease<ActivityLaunch>({
    launch: (agentId) => this.#currentActivityLaunches.get(agentId),
    runtime: (agentId) => this.#agentProcessManager.runtime(agentId),
    restartConfig: (agentId) => this.#agentProcessManager.restartConfig(agentId),
    lastBusyLaunch: (agentId) => this.#activityPublisher.lastBusy(agentId)?.launch,
    resumable: (agentId) => this.#runningMentionIdentity(agentId) !== undefined,
    sessionId: (agentId) => this.#sessionReferences.get(agentId)?.sessionId,
    isStopping: (agentId) => this.#stoppingAgents.has(agentId),
    daemonIdleFacts: (agentId) => {
      const queue = this.#agentInputQueues.get(agentId);
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
  readonly #wakeRecycle = new WakeRecycle({
    provider: (provider) => this.#createProvider(provider),
    inputQueue: (agentId) => this.#agentInputQueues.get(agentId),
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
  readonly #agentInboxes = new Map<string, AgentInboxStateMachine>();
  readonly #appInboxes = new Map<string, Promise<AgentAppInbox>>();
  readonly #notifiedAppItems = new Map<string, Map<string, Promise<boolean>>>();
  /** Per-Agent MEMORY.md and disk hints. Inert until a cloud config for an Agent is applied to
   * it (`applyConfig`/`replaceOwnerSnapshot`). */
  readonly systemCleaner: SystemCleaner;
  readonly #runtimeInstanceId = generateRuntimeInstanceId();
  readonly #startedAt = Date.now();
  readonly #agentContexts = new Map<string, string>();
  readonly #agentProxyTokens = new Map<string, string>();
  readonly #agentApiKeys = new Map<string, string>();
  /** Agents launched with the weekly-report-collect skill pack. */
  readonly #collectSkillAgents = new Set<string>();
  readonly #agentLaunches = new Map<string, Promise<AgentRuntime>>();
  readonly #sessionReferences = new Map<string, SessionReference>();
  readonly #agentInputQueues = new Map<string, AgentInputQueue>();
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
    closeAgentInputQueue: (agentId, error) => this.#closeAgentInputQueue(agentId, error),
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
  readonly #observedUsage = new Map<RuntimeProvider, UsageSnapshot>();
  /** Per-launch context-usage and service-tier readings (`agent-usage-report.ts`). */
  readonly #usageReport = new AgentUsageReport({
    sessionId: (agentId) => this.#sessionReferences.get(agentId)?.sessionId,
    envelope: () => this.#envelope(),
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
  /** Whether each phase is open per Agent, and its stale watchdog - see
   * agent-runtime/phase-tracker.ts. Providers only report the raw start/finish/interrupted
   * signal; this decides what, if anything, that becomes on the wire. A compaction also ends,
   * inferred, on resumed output, a new tool call, or the turn's end. A review does not end on
   * output or a tool call, since it is made of both; the turn's end closes it without a row. */
  readonly #phases: Readonly<Record<RuntimePhase, PhaseTracker>> = {
    compaction: this.#trackPhase("compaction"),
    review: this.#trackPhase("review"),
  };
  readonly #codeAgentInventory: CodeAgentInventorySync;
  readonly #runtimeAuth: RuntimeAuthReporter;
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
  ) {
    const runtime = this;
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
          if (!this.#deliveryQueue.isBusy(agentId)) this.#noteTurnStarted(agentId);
          this.#deliveryQueue.busy(agentId);
        },
        noticeSettled: (agentId) => {
          const launch = this.#currentActivityLaunches.get(agentId);
          if (launch) this.#reconcileIdleTurn(agentId, launch);
        },
        // The consumed cursor outlives the process. What an Agent has already reviewed decides
        // the next hold, the `seenUpToSeq` a fresh send inherits, and whether a top-level send
        // under a thread-read parent needs confirming.
        consumedSeqs: new AgentConsumedSeqStore(),
      },
    );
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
      inbox: (agentId) => this.#agentInbox(agentId),
      appItemsPending: async (agentId) => (await this.#appInbox(agentId)).list().length,
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
        upsert: async (agentId, item) => (await this.#appInbox(agentId)).upsert(item),
        remove: (agentId, itemId) => this.#removeAppItem(agentId, itemId),
      },
      wake: async (agentId, itemId) => {
        // A busy Agent sees the item at its next idle drain; a stopped one at its next launch.
        if (this.#isWorking(agentId)) return;
        await this.#notifyAppItem(agentId, itemId, { startStopped: false });
      },
    });
    this.#appConfigs = new AgentAppConfigSync({
      // `#requestAppConfigSnapshot` asks only through a transport that has the method.
      requestSnapshot: (agentId) =>
        this.#transport.requestAppConfigSnapshot!({ ...this.#envelope(), agentId }),
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
          this.#sessionInvalidateMessage(
            intent.agentId,
            intent.provider,
            sessionId,
            launchId,
            reason,
          ),
        );
      },
      result: async (result) => {
        await this.#transport.sendAgentControlResult?.(result);
      },
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

  /** Reads and reports every runtime's login status again, e.g. after a login or logout. */
  refreshRuntimeAuth(): Promise<void> {
    return this.#runtimeAuth.refresh();
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

  /**
   * Answers a server-requested breakdown of one Agent's current Claude Code context-window
   * composition. Unlike `scanUsage` (provider-wide), this is per-Agent: it resolves the
   * Agent's own current launch and native session id from what this runtime already tracks
   * (`#currentActivityLaunches`, `#sessionReferences` — the same references `#usageReport`
   * reads), never trusting `request.launchId`/`request.sessionId` to run anything; those fields are
   * only echoed back for correlation, or used to detect a request naming a launch this runtime has
   * already superseded (`error`, without running the CLI). Check order: not running ->
   * `no_session`; a stale launch -> `error`; the provider has no `readContextReport` ->
   * `unsupported`; no native session id yet -> `no_session`; otherwise the CLI runs.
   */
  async scanAgentContext(request: AgentContextScanRequest): Promise<AgentContextScanResponse> {
    this.#assertRunning();
    this.#assertOwnIntent(request);
    const answer = (outcome: AgentContextScanOutcome) =>
      agentContextScanResponse(request, this.#connection, outcome);
    const launch = this.#currentActivityLaunches.get(request.agentId);
    if (!launch)
      return answer({
        launchId: request.launchId,
        sessionId: request.sessionId,
        status: AGENT_CONTEXT_SCAN_STATUS.NO_SESSION,
      });
    if (request.launchId && launch.launchId !== request.launchId)
      return answer({
        launchId: launch.launchId,
        sessionId: request.sessionId,
        status: AGENT_CONTEXT_SCAN_STATUS.ERROR,
        message: "Agent context scan targets a superseded launch",
      });
    const config = this.#agentProcessManager.runtime(request.agentId)?.config;
    if (!config)
      return answer({
        launchId: launch.launchId,
        sessionId: request.sessionId,
        status: AGENT_CONTEXT_SCAN_STATUS.NO_SESSION,
      });
    const codeAgentProvider = this.#createProvider(config.provider);
    if (!codeAgentProvider.readContextReport)
      return answer({
        launchId: launch.launchId,
        sessionId: request.sessionId,
        status: AGENT_CONTEXT_SCAN_STATUS.UNSUPPORTED,
      });
    const sessionId = this.#sessionReferences.get(request.agentId)?.sessionId;
    if (!sessionId)
      return answer({
        launchId: launch.launchId,
        sessionId: request.sessionId,
        status: AGENT_CONTEXT_SCAN_STATUS.NO_SESSION,
      });
    try {
      const report = await codeAgentProvider.readContextReport({
        workingDirectory: agentWorkspaceDirectory(
          this.#connection.workspaceRoot,
          this.#connection.workspaceId,
          request.agentId,
        ),
        sessionId,
        timeoutMs: 20_000,
      });
      return answer(agentContextReportOutcome(launch.launchId, sessionId, report));
    } catch (error) {
      return answer(agentContextScanFailure(launch.launchId, sessionId, error));
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
    // Publications that arrive before the ready handshake completes are replayed afterwards:
    // control intents first, in arrival order, then Message deliveries. Held the way the
    // connection holds them (`HeldPublications`): the latest start and stop per Agent, capped
    // delivery notices.
    const heldControl = new HeldPublications<() => Promise<void>>();
    const heldMessages = new HeldPublications<() => Promise<void>>();
    let buffering = true;
    type Hold<Value> = (value: Value, run: () => Promise<void>) => void;
    const receive =
      <Value>(hold: Hold<Value>, handle: (value: Value) => Promise<void>) =>
      (value: Value) => {
        if (buffering) hold(value, () => handle(value));
        else void handle(value);
      };
    const latest =
      (kind: "start" | "stop" | "probe"): Hold<{ agentId: string }> =>
      (value, run) =>
        heldControl.latestFor(value.agentId, kind, run);
    const control: Hold<unknown> = (_value, run) => heldControl.add(run);
    const notice: Hold<{ agentId: string }> = (value, run) =>
      heldMessages.notice(value.agentId, run);
    const failure =
      <Request extends AgentStopIntent | AgentWorkspaceResetRequest | AgentMessageDelivery>(
        operation: "stop" | "workspace_reset" | "message_delivery",
        handle: (request: Request) => Promise<void>,
      ) =>
      (request: Request) =>
        handle(request).catch((error) =>
          logAgentOperationFailure(this.#connection.computerId, operation, request, error),
        );
    try {
      this.#upgradeResults.start();
      this.#subscribe(
        this.#transport.onReconnect?.(() => {
          const transport = this.#transport;
          void this.#codeAgentInventory
            .reportRuntimes(transport)
            .then((report) => this.#codeAgentInventory.refreshStaleCatalogs(report, transport))
            .catch(() => {});
          for (const agentId of this.#readyRunningAgentIds())
            void this.#requestReminderSnapshot(agentId).catch(() => {});
          this.#resyncAppConfigs();
          void this.#agentControl
            .replay()
            .then(() => this.#agentSessions.replay())
            .catch((error) => {
              logger.warning("Agent control recovery replay failed", {
                event: "agent_control:replay_failed",
                workspace_id: connection.workspaceId,
                computer_id: connection.computerId,
                error_code: diagnosticErrorCode(error),
                outcome: "failed",
              });
            });
          // A result whose send failed while disconnected, or one settled meanwhile.
          void this.#upgradeResults.report();
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
      this.#subscribe(
        transport.onSkillsList?.(async (request) => {
          if (
            this.#stopping ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          const result = await this.#workspaceQueries.listSkills(connection, request);
          if (!this.#stopping && this.#transport === transport)
            await transport.sendSkillsListResult?.({
              ...request,
              ...result,
              scannedAtMs: Date.now(),
            });
        }),
      );
      this.#subscribe(
        transport.onWorkspaceFilesList?.(async (request) => {
          if (
            this.#stopping ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          const result = await this.#workspaceQueries.listFiles(connection, request);
          if (!this.#stopping && this.#transport === transport)
            await transport.sendWorkspaceFilesListResult?.({ ...request, ...result });
        }),
      );
      this.#subscribe(
        transport.onWorkspaceFileRead?.(async (request) => {
          if (
            this.#stopping ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          const result = await this.#workspaceQueries.readFile(connection, request);
          if (!this.#stopping && this.#transport === transport)
            await transport.sendWorkspaceFileReadResult?.({ ...request, ...result });
        }),
      );
      this.#subscribe(
        transport.onWorkspaceDelete?.(async (request) => {
          if (
            this.#stopping ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          const result = await this.#deleteWorkspace(connection, request);
          if (!this.#stopping && this.#transport === transport)
            await transport.sendWorkspaceDeleteResult?.({ ...request, ...result });
        }),
      );
      for (const unsubscribe of subscribeProviderScans(this.#transport, {
        connection,
        runtime: this,
        currentTransport: () => this.#transport,
        isStopping: () => this.#stopping,
        runtimeAuth: this.#runtimeAuth,
        inventory: this.#codeAgentInventory,
      }))
        this.#subscribe(unsubscribe);
      // Register publication listeners before the ready RPC. The server may
      // recover persisted Agents immediately as part of that RPC.
      this.#subscribe(
        this.#transport.onAgentStart?.(
          receive(latest("start"), (intent: AgentStartIntent) =>
            this.handleAgentStart(intent).then(
              () => {},
              (error) => logAgentStartFailure(intent, error),
            ),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentStop?.(
          receive(
            latest("stop"),
            failure("stop", (intent: AgentStopIntent) => this.handleAgentStop(intent)),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentTurnInterrupt?.(
          receive(
            () => {},
            (intent: AgentTurnInterruptIntent) =>
              this.handleAgentTurnInterrupt(intent).catch((error) =>
                logger.warning("Turn interrupt failed", {
                  event: "agent_turn_interrupt:failed",
                  agent_id: intent.agentId,
                  error: thrownMessage(error),
                }),
              ),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentActivityProbe?.(
          receive(latest("probe"), (probe: AgentActivityProbe) =>
            this.handleAgentActivityProbe(probe).catch((error) =>
              logAgentActivityProbeFailure(probe, error),
            ),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentInboxPurge?.(
          receive(control, async (purge: AgentInboxPurge) => {
            try {
              this.handleAgentInboxPurge(purge);
            } catch (error) {
              logger.warn("Agent inbox purge was not applied", {
                event: "agent.inbox.purge_rejected",
                agent_id: purge.agentId,
                error_code: diagnosticErrorName(error),
              });
            }
          }),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentWorkspaceReset?.(
          receive(
            control,
            failure("workspace_reset", (request: AgentWorkspaceResetRequest) =>
              this.handleAgentWorkspaceReset(request),
            ),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onAgentMessage?.(
          receive(
            notice,
            failure("message_delivery", (message: AgentMessageDelivery) =>
              this.handleAgentMessage(message),
            ),
          ),
        ),
      );
      this.#subscribe(
        this.#transport.onConnectionRefused?.((reason) => {
          void this.stop()
            .catch((error) =>
              logger.warn("Stopping Agents after the cloud refused the connection failed", {
                event: "daemon_runtime:refused_stop_failed",
                reason,
                error_code: diagnosticErrorName(error),
              }),
            )
            .then(() => this.lifecycle.connectionRefused?.(reason));
        }),
      );
      this.#subscribe(
        this.#transport.onReminderSync?.((sync) => {
          void this.#reminders.apply(sync).catch(() => {});
        }),
      );
      this.#subscribe(this.#transport.onAppConfigSync?.((sync) => this.#appConfigs.apply(sync)));
      this.#subscribe(
        this.#transport.onAppRegistrationNotice?.((notice) => {
          void acceptAppRegistrationNotice(notice, {
            isRunning: (agentId) => this.#readyRunningAgentIds().includes(agentId),
            mint: (agentId, item) => this.mintAppItem(agentId, item),
          }).catch(() => {});
        }),
      );
      const migrations = this.#migrations;
      if (migrations) {
        // Before any lease is taken, so nothing it clears can belong to a run.
        await migrations.pruneLeftovers().catch((error: unknown) =>
          logger.warn("Clearing what Agent migrations left behind failed", {
            event: "agent_migration:prune_failed",
            error_code: diagnosticErrorName(error),
          }),
        );
        this.#subscribe(
          this.#transport.onAgentMigrationLease?.((lease) => {
            void migrations.lease(lease);
          }),
        );
        this.#subscribe(
          this.#transport.onAgentMigrationCancel?.((cancel) => {
            void migrations.cancel(cancel).catch(() => {});
          }),
        );
      }
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
          ...readOperatingSystem(),
          recoveredRestartRequestIds: this.lifecycle.recoveredRestartRequestIds ?? [],
          recoveredUpgradeRequestIds: this.lifecycle.recoveredUpgradeRequestIds ?? [],
          capabilities: readyCapabilities(!!this.#migrations),
        }),
        signal,
      );
      await this.#upgradeResults.report();
      await Promise.all(
        this.#readyRunningAgentIds().map((agentId) => this.#requestReminderSnapshot(agentId)),
      );
      this.#resyncAppConfigs();
      const heldNotices = heldMessages.take();
      if (heldNotices.dropped > 0)
        logger.warn("Delivery notices held during start were dropped; the cloud resends them", {
          event: "daemon_runtime:notices_dropped",
          dropped: heldNotices.dropped,
        });
      const buffered = [...heldControl.take().items, ...heldNotices.items];
      buffering = false;
      this.#started = true;
      this.#activityPublisher.enable();
      this.#coldIdleSweep.start();
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
    const requestUpgrade = this.lifecycle.requestUpgrade;
    if (!requestUpgrade) throw new Error("upgrade requests are unsupported");
    try {
      await requestUpgrade(requestId, expectedVersion);
      void this.#upgradeResults.report();
    } catch (error) {
      const message = thrownMessage(error);
      const errorCode = parseUpgradeErrorCode((error as { code?: unknown } | null)?.code);
      logger.warn("Computer upgrade request was refused", {
        event: "upgrade:request_refused",
        request_id: requestId,
        workspace_id: this.#connection.workspaceId,
        error_code: errorCode ?? diagnosticErrorCode(error),
        error_message: message,
      });
      await this.#upgradeResults.reportRefused({
        requestId,
        status: "failed",
        completedAtMs: Date.now(),
        error: message,
        ...(errorCode ? { errorCode } : {}),
      });
      throw error;
    }
  }

  async #deleteWorkspace(
    connection: DaemonConfig,
    request: Pick<AgentWorkspaceDeleteRequest, "agentId">,
  ): Promise<Pick<AgentWorkspaceDeleteResult, "status">> {
    try {
      if (
        this.#agentProcessManager.runtime(request.agentId) ||
        this.#agentProcessManager.isStopping(request.agentId)
      )
        await this.stopAgent(request.agentId);
      this.#forgetLocalAgent(request.agentId);
      return await deleteAgentWorkspaceFiles({
        agentWorkspaceDirectory: agentWorkspaceDirectory(
          connection.workspaceRoot,
          connection.workspaceId,
          request.agentId,
        ),
      });
    } catch {
      return { status: "error" };
    }
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
    try {
      this.#assertRunning();
      this.#assertAgentNotStopping(agentId);
      if (this.#migrations?.holds(agentId))
        throw new AgentPreflightError(
          `Agent workspace is moving to another Computer: ${agentId}`,
          "AGENT_MIGRATING",
        );
    } catch (error) {
      return Promise.reject(error);
    }
    this.#requestAppConfigSnapshot(agentId);
    const enqueueRecovery = (context: AgentRecoveryContext) =>
      this.#enqueueAgentInput(agentId, (completion) => ({ kind: "recovery", context, completion }));
    const enqueueTurn = (text: string, introduction?: true) =>
      this.#enqueueAgentInput(agentId, (completion) => ({
        kind: "prompt",
        text,
        introduction,
        completion,
      }));
    const { resumePrompt, introductionPrompt } = request;
    const carriesPrompt = introductionPrompt !== undefined || resumePrompt !== undefined;
    const introduction =
      introductionPrompt !== undefined &&
      !this.#introducedAgents.has(agentId) &&
      !this.#agentInputQueues
        .get(agentId)
        ?.items.some((item) => item.kind === "prompt" && item.introduction)
        ? introductionPrompt
        : undefined;
    // This Start's input in order: its introduction, the recovery handed over, its resume prompt.
    const enqueueStartInput = (context: AgentRecoveryContext | undefined) => {
      const introductionCompletion =
        introduction === undefined ? undefined : enqueueTurn(introduction, true);
      const recoveryCompletion = context ? enqueueRecovery(context) : undefined;
      const promptCompletion = resumePrompt === undefined ? undefined : enqueueTurn(resumePrompt);
      return {
        recoveryCompletion,
        inputs: [introductionCompletion, recoveryCompletion, promptCompletion].filter(
          (input) => input !== undefined,
        ),
      };
    };
    const existingLaunch = this.#agentLaunches.get(agentId);
    if (existingLaunch) {
      if (carriesPrompt || recoveryHasContent(recovery)) {
        const queue = this.#agentInputQueues.get(agentId);
        if (queue)
          queue.items = queue.items.filter((item) => {
            if (item.kind !== "startup") return true;
            item.completion.resolve();
            return false;
          });
      }
      // A launch in progress presents this start's input too.
      const { inputs } = enqueueStartInput(recovery);
      if (!inputs.length) return existingLaunch;
      const inputCompletion = Promise.all(inputs);
      // Input can be cancelled before provider creation finishes. Keep the creation promise as
      // the launch fence, while observing an early input rejection until creation settles.
      void inputCompletion.catch(() => {});
      const extendedLaunch = existingLaunch
        .then(async (runtime) => {
          await inputCompletion;
          return runtime;
        })
        .finally(() => {
          if (this.#agentLaunches.get(agentId) === extendedLaunch)
            this.#agentLaunches.delete(agentId);
        });
      this.#agentLaunches.set(agentId, extendedLaunch);
      return extendedLaunch;
    }
    const activeRuntime = this.#agentProcessManager.runtime(agentId);
    if (activeRuntime) {
      if (!recovery && !carriesPrompt)
        return Promise.reject(new Error(`Agent runtime is already active: ${agentId}`));
      // A running Agent keeps its process and session: it is handed only this start's
      // introduction, wake message and resume prompt, never its resume messages or unread summary.
      const { inputs } = enqueueStartInput(
        recovery?.wakeMessage ? { wakeMessage: recovery.wakeMessage } : undefined,
      );
      if (!inputs.length) return Promise.resolve(activeRuntime);
      this.#ensureAgentInputDrain(agentId);
      return Promise.all(inputs).then(() => activeRuntime);
    }

    // A brand-new process started inside the hold window would be killed seconds later by the
    // upgrade's stop. Refusing is safe: `#agentControl.replay()` re-issues the intent after the
    // restart. Launches that only extend a live runtime returned above and are untouched.
    if (this.#runnerHold !== undefined)
      return Promise.reject(new Error(`Agent launches are held for ${this.#runnerHold.reason}`));

    this.#messageAttention.clearAgent(agentId);

    // Register the launch before its first await so concurrent starts cannot mint twice.
    // Launch failure is surfaced by `launch`; the item completion is also rejected when cleared.
    // The Start's input (a resume prompt is a user's guidance when resuming a stopped Agent, sent
    // with no recovery) is queued before the launch, so any message that arrives while the process
    // is still starting queues behind it.
    const { recoveryCompletion, inputs } = enqueueStartInput(recovery);
    for (const input of inputs) void input.catch(() => {});
    // A Start carrying a prompt never gets the starter, even when it queued none of its own.
    const startupCompletion =
      !carriesPrompt && !recoveryHasContent(recovery)
        ? this.#enqueueAgentInput(agentId, (completion) => ({
            kind: "startup",
            text: agentStartupInput(
              request.sessionMode !== "create" &&
                Boolean(request.sessionId ?? this.#sessionReferences.get(agentId)?.sessionId),
            ),
            completion,
          }))
        : undefined;
    void startupCompletion?.catch(() => {});
    const launching = this.#launchAgent(agentId, config, request);
    const launch = launching
      .then(
        async (runtime) => {
          // Any successful launch, a managed Start included, ends a wake cooldown.
          this.#wakeLaunchFailures.reset(agentId);
          this.#ensureAgentInputDrain(agentId);
          if (recoveryCompletion) await recoveryCompletion;
          // No recovery item was enqueued for this launch at all (so
          // `#recoverAttention` never ran), yet the session is ready — flush anything
          // AgentDeliveryQueue held across an unexpected exit now. Do not open a
          // second recovery notice: the queued startup input opens the initial turn if needed.
          else this.#releaseSurvivingHolds(agentId);
          if (startupCompletion) await startupCompletion;
          return runtime;
        },
        (error: unknown) => {
          this.#exitedDelivery.keepInputDeliveriesForNextLaunch(agentId, error);
          this.#closeAgentInputQueue(agentId, error);
          throw error;
        },
      )
      .finally(() => {
        if (this.#agentLaunches.get(agentId) === launch) this.#agentLaunches.delete(agentId);
      });
    this.#agentLaunches.set(agentId, launch);
    return launch;
  }

  #enqueueAgentInput(
    agentId: string,
    create: (completion: AgentInputCompletion) => AgentInput,
  ): Promise<void> {
    const queue = this.#agentInputQueues.get(agentId) ?? { items: [], closed: false };
    if (queue.closed) return Promise.reject(new Error(`Agent runtime is stopping: ${agentId}`));
    const completion = new Promise<void>((resolve, reject) => {
      queue.items.push(create({ resolve, reject }));
    });
    this.#agentInputQueues.set(agentId, queue);
    return completion;
  }

  #ensureAgentInputDrain(agentId: string): void {
    const queue = this.#agentInputQueues.get(agentId);
    // The runner hold is enforced here as well as at handleAgentMessage: draining is what calls
    // AgentMessageAttentionIndex.receive, which notifies the session and then sends the
    // `agent:deliver:ack`. Not draining is therefore exactly "accepted locally, never acked", so
    // the server's AgentMessageDelivery.receivedAt stays null and it republishes after restart.
    if (
      !queue ||
      queue.closed ||
      queue.drain ||
      this.#runnerHold !== undefined ||
      !this.#agentProcessManager.session(agentId)
    )
      return;
    queue.drain = this.#drainAgentInputs(agentId, queue).finally(() => {
      queue.drain = undefined;
      if (queue.closed || !queue.items.length) {
        if (this.#agentInputQueues.get(agentId) === queue) this.#agentInputQueues.delete(agentId);
        return;
      }
      this.#ensureAgentInputDrain(agentId);
    });
  }

  async #drainAgentInputs(agentId: string, queue: AgentInputQueue): Promise<void> {
    while (!queue.closed) {
      const item = queue.items.shift();
      if (!item) return;
      const responses = this.#currentActivityLaunches.get(agentId)?.startup?.responses ?? 0;
      try {
        if (
          item.kind === "startup" &&
          (queueHasInputContent(queue.items) ||
            this.#deliveryQueue.hasQueued(agentId) ||
            this.#agentProcessManager.session(agentId)?.hasLiveTurn === true)
        ) {
          item.completion.resolve();
          continue;
        }
        if (item.kind === "delivery") {
          await (isTrackedMention(item.message)
            ? this.#mentionDeliveries.deliver(item.message)
            : this.#messageAttention.receive(item.message));
          logger.info("Agent delivery indexed", {
            event: "agent.message.delivery_indexed",
            agent_id: agentId,
            delivery_id: item.message.deliveryId,
            message_id: item.message.messageId,
            target: item.message.target,
            sequence: item.message.sequence,
          });
        } else if (item.kind === "startup") {
          const session = this.#agentProcessManager.session(agentId);
          const launch = this.#currentActivityLaunches.get(agentId);
          // Release the queue at real readiness if this provider awaits the whole turn.
          if (session && launch) {
            this.#noteTurnStarted(agentId);
            await launch.startup?.run(session.sendMessage(item.text));
          }
        } else if (item.kind === "prompt") {
          await this.#runPromptTurn(agentId, item.text, item.introduction);
        } else await this.#recoverAttention(agentId, item.context);
      } catch (error) {
        if (
          (item.kind === "recovery" || item.kind === "startup") &&
          this.#agentLaunches.has(agentId)
        ) {
          if (this.#stoppingAgents.has(agentId)) {
            item.completion.reject(error);
            return;
          }
          const launch = this.#currentActivityLaunches.get(agentId);
          if (launch?.startup && !launch.startup.endsLaunch(error, responses)) {
            // The model already answered this input: the launch stands, like a refused prompt.
            logger.warn("Agent startup input was not accepted", {
              event: "agent.startup_input.rejected",
              agent_id: agentId,
              input_kind: item.kind,
              error_code: diagnosticErrorCode(error),
            });
            item.completion.resolve();
            continue;
          }
          if (item.kind === "startup" && launch && !launch.startup?.errorObserved)
            this.#activityPublisher.publish(
              agentId,
              launch,
              this.#runtimeErrorActivity(
                agentId,
                scrubRuntimeErrorText(
                  error instanceof Error ? error.message : "Agent startup input was rejected",
                ),
              ),
            );
          item.completion.reject(await this.#abandonLaunch(agentId, error));
          return;
        }
        if (item.kind === "delivery") {
          item.completion.reject(error);
          continue;
        }
        if (item.kind === "prompt") {
          // The launch stands: a provider that refuses input handles it as any refused input.
          logger.warn("Agent prompt turn was not accepted", {
            event: "agent.prompt_turn.rejected",
            agent_id: agentId,
            error_code: diagnosticErrorCode(error),
          });
          item.completion.reject(error);
          continue;
        }
      }
      item.completion.resolve();
    }
  }

  async #recoverAttention(agentId: string, context: AgentRecoveryContext): Promise<void> {
    const messages = [
      ...(context.wakeMessage ? [context.wakeMessage] : []),
      ...(context.resumeMessages ?? []),
    ];
    const hasRecoveryContent = recoveryHasContent(context);
    try {
      if (hasRecoveryContent)
        await this.#messageAttention.recover(
          agentId,
          messages,
          context.unreadSummary ?? {},
          context.unreadConversationIds ?? {},
        );
    } catch (error) {
      logger.warn("Agent recovery notice was not accepted; canonical unread state remains", {
        event: "agent.recovery_notice.rejected",
        agent_id: agentId,
        error_code: diagnosticErrorName(error),
      });
      throw error;
    }
    // Reconcile whatever AgentDeliveryQueue held across an unexpected exit now that
    // this launch's recovery pass has run. `recover()` above already told the Agent about the
    // same canonical unread state (the server's own unread ledger, not this in-memory queue, is
    // what a crashed-and-relaunched Agent's `resumeMessages`/`unreadSummary` are built from) —
    // drop the surviving held deliveries (acknowledged when they were held) instead of a second,
    // redundant notice for them.
    // When there was no recovery content, nothing else has told the Agent, so flush them now,
    // treating the freshly launched session as idle.
    if (hasRecoveryContent) this.#dropSurvivingDeliveryQueue(agentId);
    else this.#flushSurvivingDeliveryQueue(agentId);
    // App items (reminders, etc.) are a separate subsystem from canonical Message unread state
    // (`agent-app-inbox/`); `recover()` above never mentions them, so a held one is always
    // released here regardless of `hasRecoveryContent`, never dropped. A surviving fallback
    // notice (Kiro's `notice-undelivered`) is treated the same way for the same reason: this
    // in-memory queue does not know whether the text it held came from a Message delivery
    // `recover()` already covers or an App Inbox notice it never mentions, so always releasing
    // it is the only choice that never silently drops one.
    this.#releaseHeldAppItems(agentId);
    this.#releaseFallbackNotices(agentId);
  }

  /** The fields every daemon -> server report opens with: this protocol, a fresh request id, and
   * this runtime's own Workspace and Computer. */
  #envelope() {
    return {
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: this.#connection.workspaceId,
      computerId: this.#connection.computerId,
    };
  }

  /**
   * The daemon has taken this delivery into its own keeping (for a later launch, a batch, or to
   * drop it), so it acknowledges it now, as the server needs no further copy. A failed ACK only
   * means the server replays it on the next `ready`; nothing is lost, since a daemon restart
   * recovers unread messages from the cloud read boundary, not from ACK state.
   */
  #acknowledgeCustody(message: AgentMessageDelivery): void {
    this.#messageAttention.acknowledgeCustody(message);
  }

  /** Queues a delivery as the Agent's next input; settles once the input drain handled it. */
  #enqueueDelivery(agentId: string, message: AgentMessageDelivery): Promise<void> {
    return this.#enqueueAgentInput(agentId, (completion) => ({
      kind: "delivery",
      message,
      completion,
    }));
  }

  /** Drops whatever `AgentDeliveryQueue` held for `agentId` across an unexpected exit — used when
   * this launch's `recover()` pass already covered the same unread state, so notifying about them
   * again would be redundant. Each was acknowledged when the daemon took it. */
  #dropSurvivingDeliveryQueue(agentId: string): void {
    this.#deliveryQueue.discardPending(agentId);
  }

  /** Flushes whatever `AgentDeliveryQueue` held for `agentId` across an unexpected
   * exit, treating the (fresh or just-recovered) session as idle — used when nothing else has
   * told the Agent about it. */
  #flushSurvivingDeliveryQueue(agentId: string): void {
    const held = this.#deliveryQueue.idle(agentId);
    if (!held.length) return;
    void this.#messageAttention.flush(agentId, held).catch((error: unknown) => {
      // Already acknowledged when held: they come back as unread on the next Start or daemon
      // restart, not from a `ready` replay.
      logger.warn("Held Agent deliveries were not accepted at launch", {
        event: "agent.delivery_queue.flush_rejected",
        agent_id: agentId,
        held_count: held.length,
        already_acknowledged: true,
        error_code: diagnosticErrorName(error),
      });
    });
  }

  /** Opens a turn with `text`: the resume prompt a user's Start sent, or the introduction the
   * server asks for. */
  async #runPromptTurn(agentId: string, text: string, introduction?: true): Promise<void> {
    const session = this.#agentProcessManager.session(agentId);
    if (!session?.notify) {
      logger.debug("Agent prompt turn skipped: the session accepts no input", {
        event: "agent.prompt_turn.skipped",
        agent_id: agentId,
      });
      return;
    }
    if (introduction) this.#introducedAgents.add(agentId);
    this.#noteTurnStarted(agentId);
    await session.notify(text);
  }
  #noteTurnStarted(agentId: string): void {
    const launch = this.#currentActivityLaunches.get(agentId);
    if (!launch?.progress) return;
    launch.progress.noteTurnStarted();
    launch.stalled?.start(agentId, stalledTurnObservation(launch));
  }

  /** Tears down a launch whose recovery notice was rejected; returns the error to surface. */
  async #abandonLaunch(agentId: string, error: unknown): Promise<unknown> {
    this.#stoppingAgents.add(agentId);
    this.#closeAgentInputQueue(agentId, error);
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    activityLaunch?.startup?.dispose();
    if (activityLaunch) activityLaunch.stopping = true;
    this.#interruptIfBusy(agentId, activityLaunch);
    this.#activityPublisher.forgetBusy(agentId);
    this.#disposeLaunchObservations(agentId);
    this.#revokeLocalLaunch(agentId);
    // An abandoned launch is teardown, not a person's Stop: an offline error's record must
    // survive so later deliveries still restate the failure that took the Agent down.
    const offlineError = this.#offlineResidency.record(agentId);
    try {
      await this.#releaseAgentRuntime(agentId);
      if (offlineError) this.#offlineResidency.remember(agentId, offlineError);
      if (!this.#agentStops.has(agentId)) this.#stoppingAgents.delete(agentId);
      return error;
    } catch (cleanupError) {
      return cleanupError;
    }
  }

  #closeAgentInputQueue(agentId: string, error: unknown): void {
    this.#introducedAgents.delete(agentId);
    const queue = this.#agentInputQueues.get(agentId);
    if (!queue) return;
    queue.closed = true;
    for (const item of queue.items.splice(0)) {
      if (item.kind === "delivery")
        this.#mentionDeliveries.drop(
          item.message,
          MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
        );
      item.completion.reject(error);
    }
    if (!queue.drain) this.#agentInputQueues.delete(agentId);
  }

  async #requestLaunchConfig(
    agentId: string,
    managedScope: { controlEpoch?: number; requestId: string; launchId: string } | undefined,
  ) {
    const { workspaceId } = this.#connection;
    if (this.#transport.requestAgentLaunchConfig)
      return this.#transport.requestAgentLaunchConfig({
        agentId,
        workspaceId,
        ...(managedScope ? managedScope : {}),
      });
    if (this.#transport.requestAgentApiKey)
      return { agentApiKey: await this.#transport.requestAgentApiKey({ agentId, workspaceId }) };
    throw new Error("Agent API key endpoint is not configured");
  }

  async #launchAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    request: LaunchRequest,
  ): Promise<AgentRuntime> {
    const { control } = request;
    // A daemon-initiated launch (no `control` — a wake, never a server Start) reuses
    // the last server-supplied launch identity remembered alongside this Agent's restart config,
    // instead of minting a fresh one. An Agent with no remembered identity (never brought under
    // AgentControl, or already forgotten by an explicit Stop) keeps minting, unchanged.
    const serverLaunch = control ? undefined : this.#agentProcessManager.serverLaunch(agentId);
    const { requestId, reference, previousLaunchId, launchId, reused, managedScope } =
      resolveLaunchIdentity({
        request,
        provider: config.provider,
        previous: this.#sessionReferences.get(agentId),
        serverLaunch,
      });
    this.#sessionReferences.set(agentId, reference);
    const launch: ActivityLaunch = {
      launchId,
      clientSeq: reused ? this.#agentProcessManager.lastClientSeq(agentId) : 0,
      stopping: false,
    };
    if (!control)
      logger.info("Agent self-initiated launch resolved its launch identity", {
        event: "agent_control:wake_launch",
        agent_id: agentId,
        launch_id: launch.launchId,
        request_id: managedScope?.requestId,
        epoch: managedScope?.controlEpoch,
        outcome: reused ? "reused" : "minted",
      });
    this.#currentActivityLaunches.set(agentId, launch);
    this.#activityPublisher.forgetBusy(agentId);
    this.#disposePhases(agentId);
    // This launch's delivery mode, read by AgentMessageAttentionIndex.receive via
    // #deliveryQueue.shouldHold on every delivery for this Agent from now on.
    this.#deliveryQueue.setProvider(agentId, config.provider);
    this.#usageReport.forget(agentId);
    this.#fastModeWarned.delete(agentId);
    // AgentControl's fresh retry after a kiro/pi AgentSessionRecoveryError: the invalidate was
    // already reported before this launch (see `invalidateSession` above); narrate the cold
    // start here, where the real launch's ActivityLaunch now exists. `invalidateReason` is
    // threaded explicitly through this one launch's request (see `LaunchRequest`), never a
    // side channel: it can neither outlive this launch nor attach to a later unrelated one.
    if (request.replacedSessionId && request.invalidateReason) {
      const { detail, entryText } = sessionInvalidateActivityText(
        runtimeDisplayName(config.provider),
        request.replacedSessionId,
        request.invalidateReason,
      );
      this.#activityPublisher.publish(
        agentId,
        launch,
        this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE, "info", detail, {
          entries: [{ kind: "text", text: entryText }],
        }),
      );
    }
    const current = () => this.#currentActivityLaunches.get(agentId) === launch && !launch.stopping;
    let agentApiKey: string | undefined;
    try {
      const launchConfig = await this.#requestLaunchConfig(agentId, managedScope).catch(
        (error: unknown) => {
          throw new AgentAuthorizationError(error);
        },
      );
      agentApiKey = launchConfig.agentApiKey;
      this.#assertRunning();
      this.#assertAgentNotStopping(agentId);
      this.#agentApiKeys.set(agentId, agentApiKey);
      const proxyToken = this.#agentProxy?.issue(agentId, agentApiKey);
      if (proxyToken) this.#agentProxyTokens.set(agentId, proxyToken);
      const localContext = proxyToken ?? this.#contextFor(agentId);
      const desktopEnvironment = await this.#desktops.hold(agentId);
      const workspaceDirectory = agentWorkspaceDirectory(
        this.#connection.workspaceRoot,
        this.#connection.workspaceId,
        agentId,
      );
      // A session left cold with a large context is not resumed: a fresh one opens with a briefing.
      const recycled = request.replacedSessionId
        ? undefined
        : await this.#wakeRecycle.plan({
            agentId,
            provider: config.provider,
            envVars: launchConfig.envVars,
            sessionId: reference.sessionId,
            sessionMode: reference.sessionMode,
            hasResumePrompt: request.resumePrompt !== undefined,
            memoryAgent: isMemoryAgentRuntime(config),
            agentWorkspaceDirectory: workspaceDirectory,
          });
      // `reference.sessionId` is overwritten by the next report.
      const recycledSessionId = recycled ? reference.sessionId : undefined;
      if (recycled)
        this.#activityPublisher.publish(
          agentId,
          launch,
          this.#activity(
            agentId,
            AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE,
            "info",
            recycled.activityText,
          ),
        );
      const runtime = await this.#agentProcessManager.start(
        agentId,
        {
          ...config,
          ...(launchConfig.providerConfig ? { providerConfig: launchConfig.providerConfig } : {}),
          envVars: launchConfig.envVars,
        },
        {
          agentWorkspaceDirectory: workspaceDirectory,
          sessionId: recycled ? undefined : reference.sessionId,
          environment: {
            ...desktopEnvironment,
            COFORGE_DAEMON_SOCKET: "",
            COFORGE_AGENT_CONTEXT: localContext,
            COFORGE_AGENT_PROXY_URL: this.#agentProxy?.url ?? "",
            // Same server-authored identity the standing prompt's "Current Runtime Context"
            // section renders; exported so the Agent process and every tool it spawns
            // can read these facts directly instead of parsing them out of prose.
            ...agentRuntimeContextEnvironment({
              agentId,
              agentWorkspaceDirectory: workspaceDirectory,
              identity: launchConfig.identity,
            }),
          },
          runtimeId: launch.launchId,
          onSessionId: this.#transport.reportAgentSession
            ? async (reportedSessionId, driverReplacedSessionId) => {
                if (!current() || this.#stopping)
                  throw new Error("Agent session launch was superseded");
                // Kept for compat on the session report's own `replacedSessionId` field only
                // (unrelated to whether an invalidate is sent below): either a driver-reported
                // replacement just now, or one carried over from AgentControl's own retry.
                const replaced =
                  driverReplacedSessionId ?? recycledSessionId ?? request.replacedSessionId;
                if (driverReplacedSessionId) {
                  // Claude Code/Codex replace a missing native session inside the driver, with
                  // no separate "before the fresh launch" moment; this callback IS the point the
                  // daemon learns of it. Only a driver-reported replacement (this callback's own
                  // argument, never AgentControl's carried-over `request.replacedSessionId`,
                  // which was already reported once by `invalidateSession` before this launch)
                  // emits here — fixes a prior bug that re-sent a second invalidate/Activity for
                  // AgentControl's own retry, including harmlessly for `session_in_use`, which
                  // never sets `request.replacedSessionId` together with a reason to begin with.
                  // Sent BEFORE the session report below — fire-and-forget, never awaited, never
                  // delays or fails the report — so the server's exact match against the still-
                  // current stale session can still succeed; once the report lands below the
                  // server has already moved to the new id and this would always be a no-op.
                  this.#transport.sendSessionInvalidate?.(
                    this.#sessionInvalidateMessage(
                      agentId,
                      config.provider,
                      driverReplacedSessionId,
                      launch.launchId,
                      "missing",
                    ),
                  );
                }
                await this.#reportAgentSession({
                  ...this.#envelope(),
                  agentId,
                  provider: config.provider,
                  sessionId: reportedSessionId,
                  ...(replaced ? { replacedSessionId: replaced } : {}),
                  daemonInstanceId: this.#runtimeInstanceId,
                  launchId: launch.launchId,
                  // Read live off `reference` (the same object `#rebindAgent` mutates in place),
                  // not the `requestId`/`control` consts this closure captured at
                  // launch time: a driver-side session replacement reported after a rebind must
                  // carry the NEW request/epoch, not the one this launch started under.
                  startRequestId: reference.requestId,
                  ...(reference.controlEpoch ? { controlEpoch: reference.controlEpoch } : {}),
                  ...(previousLaunchId ? { previousLaunchId } : {}),
                });
                if (!current()) return;
                reference.sessionId = reportedSessionId;
                reference.sessionMode = "resume";
                reference.launchId = launch.launchId;
                if (driverReplacedSessionId) {
                  const { detail, entryText } = sessionInvalidateActivityText(
                    runtimeDisplayName(config.provider),
                    driverReplacedSessionId,
                    "missing",
                  );
                  this.#activityPublisher.publish(
                    agentId,
                    launch,
                    this.#activity(
                      agentId,
                      AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE,
                      "info",
                      detail,
                      {
                        entries: [{ kind: "text", text: entryText }],
                      },
                    ),
                  );
                }
              }
            : undefined,
          sessionMode: recycled ? "create" : reference.sessionMode,
          assignedSkillPacks: parseAssignedSkillPacks(launchConfig.assignedSkillPacks),
          identity: launchConfig.identity,
          serverLaunch: managedScope
            ? {
                requestId: managedScope.requestId,
                controlEpoch: managedScope.controlEpoch ?? 0,
                launchId: managedScope.launchId,
              }
            : undefined,
        },
      );
      if (
        parseAssignedSkillPacks(launchConfig.assignedSkillPacks).includes("weekly-report-collect")
      )
        this.#collectSkillAgents.add(agentId);
      if (this.#stoppingAgents.has(agentId)) {
        await this.#agentProcessManager.stop(agentId);
        throw new Error(`Agent runtime is stopping: ${agentId}`);
      }
      this.#sendAgentStatus(agentId, "active");
      this.#activityPublisher.publish(agentId, launch, {
        ...this.#startingActivity(agentId),
        requestId,
      });
      launch.startup = new AgentStartup(() => this.#scheduleStartupFailure(agentId, launch));
      const trajectories = new Map<string, ActivityTrajectory>();
      const trajectoryFor = (scope: AgentRuntimeEvent["conversation"]) => {
        const key = scope?.conversationId ?? "";
        let trajectory = trajectories.get(key);
        if (!trajectory) {
          trajectory = new ActivityTrajectory((event) =>
            this.#observeRuntimeEvent(agentId, launch, config, runtime, Boolean(control), {
              ...event,
              ...(scope ? { conversation: scope } : {}),
            }),
          );
          trajectories.set(key, trajectory);
        }
        return trajectory;
      };
      const trajectory = {
        accept: (event: AgentRuntimeEvent) => trajectoryFor(event.conversation).accept(event),
        flush: () => {
          for (const item of trajectories.values()) item.flush();
        },
        dispose: () => {
          for (const item of trajectories.values()) item.dispose();
          trajectories.clear();
        },
      };
      launch.trajectory = trajectory;
      const progress = new ProviderProgress();
      launch.progress = progress;
      const toolCalls = new ToolCallLedger();
      launch.toolCalls = toolCalls;
      launch.stalled = new StalledTurnTracker(
        stalledTurnNotice(launch, {
          isCurrent: (id) => this.#currentActivityLaunches.get(id) === launch,
          publish: (id, detail) =>
            this.#activityPublisher.publish(
              id,
              launch,
              this.#activity(id, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED, "error", detail),
            ),
        }),
        stalledTurnSilenceMs(config.envVars),
      );
      const replyIntents = this.#replyIntents.tracker(agentId, launch);
      launch.replyIntents = replyIntents;
      launch.backgroundTasks = new OutstandingBackgroundTasks();
      const unsubscribe = runtime.session.subscribe((event) => {
        progress.observe();
        toolCalls.observe(event);
        replyIntents.observe(event);
        const isCurrent = current();
        // Raw: text and thinking count before the trajectory coalesces them, and before this
        // event marks the Agent busy (a hold released while busy flushes only at the turn end).
        const recoverySignal = isCurrent ? runtimeErrorRecoverySignal(event) : undefined;
        if (recoverySignal)
          this.#runtimeErrorHold.noteRecoverySignal(
            agentId,
            recoverySignal,
            launch.runtimeErrorClassFence,
          );
        if (isCurrent) launch.startup?.observe(event);
        const turnActivity =
          event.type === "activity"
            ? isBusyActivityDetailKind(event.activity.detailKind)
            : TURN_ACTIVITY_EVENT_TYPES.has(event.type);
        if (turnActivity && this.#reconcileIdleTurn(agentId, launch)) return;
        trajectory.accept(event);
      });
      runtime.session.onExit(() => {
        this.#desktops.end(agentId);
        launch.startup?.dispose();
        trajectory.dispose();
        replyIntents.dispose();
        if (this.#currentActivityLaunches.get(agentId) !== launch) return;
        // No leaked watchdog timer, and a later launch for this Agent starts clean.
        this.#disposeLaunchObservations(agentId);
        this.#collectSkillAgents.delete(agentId);
        this.#introducedAgents.delete(agentId);
        this.#messageAttention.clearAgent(agentId);
        // An unexpected exit only clears busy — whatever a queue_until_idle provider
        // was still holding stays queued for the next launch; only explicit Stop discards it
        // (see #releaseAgentRuntime).
        this.#deliveryQueue.onProcessExit(agentId);
        this.#revokeLocalLaunch(agentId, localContext, proxyToken);
        void this.#revokeAgentApiKey(agentId, agentApiKey).catch((revokeError) => {
          // Local access is already revoked; the key stays pending and is retried later.
          logAgentApiKeyRevokeFailed(agentId, revokeError);
        });
        unsubscribe();
        if (launch.stopping) return;
        // A process that ended without a crash has stopped working too.
        if (!launch.crashDetail) this.systemCleaner.onAgentWorkingToIdle(agentId);
        // A reused launch is tracked by AgentControl exactly like a managed one is —
        // its exit must flip the on-disk record back to "stopped" (via `wake()`'s mirror image,
        // `stopped()`) so a later wake or server Start sees a truthful record.
        if (control || reused)
          void runtime.session
            .readSessionIdentity?.()
            .then((identity) => this.#agentControl.stopped(agentId, launch.launchId, identity))
            .then(() => this.#agentSessions.replay(agentId))
            .catch(() => {});
        // An exit that leaves the most recent `error` event unresolved by a `completed`
        // outcome is a crash; any other unintentional exit keeps the stopped wording, because
        // the Agent's control state is stopped either way.
        // An exit after an offline error republishes that error's Activity (the same wording,
        // as the reference Computer does at close) rather than a bare `runtime_crashed`.
        const crashed = launch.offlineError
          ? this.#activity(
              agentId,
              launch.offlineError.detailKind,
              launch.offlineError.level,
              launch.offlineError.detail,
              {
                entries: launch.offlineError.entries,
                runtimeError: launch.offlineError.runtimeError,
              },
            )
          : launch.crashDetail && buildRuntimeCrashedActivity(launch.crashDetail);
        this.#activityPublisher.publish(
          agentId,
          launch,
          crashed
            ? this.#activity(agentId, crashed.detailKind, crashed.level, crashed.detail, {
                entries: crashed.entries,
                runtimeError: crashed.runtimeError,
              })
            : this.#stoppedActivity(agentId),
        );
        if (this.#currentActivityLaunches.get(agentId) === launch)
          this.#currentActivityLaunches.delete(agentId);
      });
      // The process manager owns the restart identity; control records still belong here.
      if (reused) void this.#agentControl.wake(agentId, launch.launchId).catch(() => {});
      void this.drainAppInboxNotices(agentId).catch(() => {});
      return runtime;
    } catch (error) {
      this.#desktops.end(agentId);
      launch.startup?.dispose();
      this.#revokeLocalLaunch(agentId);
      if (agentApiKey) {
        try {
          await this.#revokeAgentApiKey(agentId, agentApiKey);
        } catch (revokeError) {
          logAgentApiKeyRevokeFailed(agentId, revokeError);
        }
      }
      if (!this.#stopping && !this.#stoppingAgents.has(agentId)) {
        // The Activity sends people to the Computer log for the cause; this is that line.
        logger.warning("Agent launch failed", {
          event: "agent_runtime:launch_failed",
          agent_id: agentId,
          provider: config.provider,
          launch_id: launch.launchId,
          ...launchFailureLogFields(error),
          outcome: "failed",
        });
        this.#sendAgentStatus(agentId, "inactive");
        // A thrown launch failure whose text classifies as an offline error (auth, plan access)
        // gets that failure's prompt and offline record, not the generic launcher wording — as
        // the reference Computer does for `runtime.start.request_failed`. The launch-failure
        // reason in the log above stays the typed one; classification only chooses what the
        // person sees and what a later `no_process` rejection restates.
        const offlineLaunchError =
          launch.offlineError ??
          this.#offlineResidency.thrownLaunchActivity(
            agentId,
            launch,
            runtimeDisplayName(config.provider),
            config,
            error,
          );
        this.#activityPublisher.publish(
          agentId,
          launch,
          offlineLaunchError
            ? this.#activity(
                agentId,
                offlineLaunchError.detailKind,
                offlineLaunchError.level,
                offlineLaunchError.detail,
                {
                  entries: offlineLaunchError.entries,
                  runtimeError: offlineLaunchError.runtimeError,
                },
              )
            : this.#launchFailureActivity(agentId, config.provider, error),
        );
      }
      if (this.#currentActivityLaunches.get(agentId) === launch) {
        this.#activityPublisher.forgetBusy(agentId);
        this.#disposeLaunchObservations(agentId);
        // An explicit Stop still needs this identity to report its final outcome.
        if (!this.#agentStops.has(agentId)) this.#currentActivityLaunches.delete(agentId);
      }
      throw error;
    }
  }

  async #failAgentStartup(agentId: string, launch: ActivityLaunch): Promise<void> {
    if (this.#stopping || launch.stopping || this.#currentActivityLaunches.get(agentId) !== launch)
      return;
    const detail = `Agent runtime did not become ready within ${AGENT_STARTUP_TIMEOUT_MS / 1000} seconds. Check the provider on this Computer, then start the Agent again.`;
    const error = new Error(detail);
    if (!launch.startup?.fail(error)) return;
    logger.warning("Agent runtime startup failed", {
      event: "agent_runtime:startup_timed_out",
      agent_id: agentId,
      launch_id: launch.launchId,
      timeout_ms: AGENT_STARTUP_TIMEOUT_MS,
      outcome: "failed",
    });
    this.#activityPublisher.publish(agentId, launch, this.#runtimeErrorActivity(agentId, detail));
    const outcome = await this.#abandonLaunch(agentId, error);
    if (outcome !== error) throw outcome;
    await this.#agentControl.stopped(agentId, launch.launchId);
  }

  #scheduleStartupFailure(agentId: string, launch: ActivityLaunch): void {
    void this.#failAgentStartup(agentId, launch).catch((error: unknown) => {
      logger.error("Agent startup cleanup did not confirm process exit", {
        event: "agent_runtime:startup_cleanup_failed",
        agent_id: agentId,
        error_code: diagnosticErrorCode(error),
      });
    });
  }

  /**
   * Rebinds the agent's already-running process to a newer control scope:
   * `AgentControl.start()`'s single seam for "a Start met a process that is already running
   * under an older, terminal operation." Never spawns or stops anything, never requests a new
   * launch config/credential (the running process's Agent API key and local proxy token are
   * kept) — it only re-points every place the runtime remembers this launch's identity so a
   * later daemon->server message about this process carries the new scope, then immediately
   * re-reports the Session and `agent:status(active)` under it. Returns the running process's
   * current Session identity, exactly like `#launchAgent` returns one for a fresh launch, so
   * `AgentControl.start()` can report it in the rebind's `started` result.
   *
   * Every closure/map this mutates is mutated IN PLACE (`activityLaunch.launchId = launchId`,
   * not a new `ActivityLaunch` object) rather than replaced, so the `#launchAgent` closures that
   * already hold a reference to it — the process-exit handler's `#agentControl.stopped(agentId,
   * launch.launchId, ...)`, `AgentActivityPublisher`'s `launch.launchId`/`launch.clientSeq`
   * and its last-busy `{ launch, ... }` identity comparisons — see the update for free,
   * without restructuring each one individually or losing the exit handler's `#currentActivityLaunches.get(agentId)
   * === launch` identity check (a *replacement* object there would silently turn that handler
   * into a no-op for the rebound launch).
   */
  async #rebindAgent(
    intent: AgentStartIntent,
    launchId: string,
  ): Promise<SessionIdentity | undefined> {
    const agentId = intent.agentId;
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    const reference = this.#sessionReferences.get(agentId);
    const previousLaunchId = activityLaunch?.launchId ?? reference?.launchId;
    if (activityLaunch) {
      activityLaunch.launchId = launchId;
      // The server's Activity idempotency key is (agentId, launchId, clientSeq)
      // (docs/observability/activity-delivery-and-errors.md); restarting it at the daemon's normal initial value under a NEW
      // launchId is exactly what a fresh launch already does and stays disjoint from every
      // clientSeq already sent under the previous launchId.
      activityLaunch.clientSeq = 0;
    }
    // Rebind moves this Agent to a genuinely new server launch identity — remember it
    // (a later wake must reuse THIS one, not the one being replaced) and reset the survived
    // clientSeq counter in lockstep with `activityLaunch.clientSeq` above.
    this.#agentProcessManager.rememberServerLaunch(agentId, {
      requestId: intent.requestId,
      controlEpoch: intent.controlEpoch ?? 0,
      launchId,
    });
    this.#agentProcessManager.recordClientSeq(agentId, 0);
    if (reference) {
      reference.requestId = intent.requestId;
      reference.controlEpoch = intent.controlEpoch;
      reference.launchId = launchId;
    }
    const session = this.#agentProcessManager.session(agentId);
    const identity = await session?.readSessionIdentity?.();
    // A rebind sends `agent:session` as a direct, fire-and-forget report (like
    // `#launchAgent`'s own closure), not through `AgentSessions.capture`/`replay` (which would
    // re-enter `state.run` for this agentId and deadlock: `AgentControl.start()` is already
    // running inside that same per-agent mutex). `previousLaunchId` carries the launch being
    // replaced so `AgentSessions.verify` on the server can accept the hand-over even if it does
    // not yet trust the new `launchId` alone.
    if (identity?.sessionId && this.#transport.reportAgentSession) {
      try {
        await this.#reportAgentSession({
          ...this.#envelope(),
          agentId,
          provider: intent.provider,
          sessionId: identity.sessionId,
          startRequestId: intent.requestId,
          daemonInstanceId: this.#runtimeInstanceId,
          launchId,
          ...(previousLaunchId ? { previousLaunchId } : {}),
          ...(intent.controlEpoch !== undefined ? { controlEpoch: intent.controlEpoch } : {}),
        });
      } catch {
        // `reportAgentSession` already logs `agent_session:report_failed` at error level; a
        // failed immediate re-report is not fatal here — the persisted `record.report`
        // (`AgentSessions.capture`, in `AgentControl.start()`) is still replayed on the next
        // ready/reconnect pass.
      }
    }
    this.#sendAgentStatus(agentId, "active");
    return identity;
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
    const publish = (id: string, source: PublishedActivityLaunch, activity: ActivityDraft) =>
      this.#activityPublisher.publish(id, source, {
        ...activity,
        ...(event.conversation
          ? {
              conversationId: event.conversation.conversationId,
              conversationTarget: event.conversation.target,
            }
          : {}),
      });
    // Runtime work marks busy unless the provider knows it has no live turn.
    // "completed" supplies the turn outcome below; native-state reconciliation
    // repairs observation and delivery gating without inventing that outcome.
    if (
      event.type !== "session" &&
      event.type !== "usage" &&
      event.type !== "completed" &&
      runtime.session.hasLiveTurn !== false
    )
      this.#deliveryQueue.busy(agentId);
    if (endsStalledTurn(event, runtime.session.hasLiveTurn)) launch.stalled?.finish(agentId);
    else if (this.#isWorking(agentId) || runtime.session.hasLiveTurn === true)
      launch.stalled?.observe(agentId, stalledTurnObservation(launch));
    if (event.type === "session") {
      if (controlled && !event.conversation)
        void this.#agentSessions.update(agentId, launch.launchId, event.identity).catch(() => {});
      return;
    }
    if (event.type === AGENT_RUNTIME_EVENT_TYPE.USAGE) {
      if (event.snapshot.provider === config.provider) this.#rememberUsage(event.snapshot);
      return;
    }
    if (event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE) {
      this.#usageReport.contextUsage(
        agentId,
        launch,
        config.provider,
        event.usedTokens,
        event.windowTokens,
      );
      return;
    }
    if (event.type === AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER) {
      // Only a launch that actually asked for Fast mode has anything to report about it: a
      // runtime volunteering a tier for an ordinary launch is not news, and the Web has no
      // switch on for it.
      if (config.fastMode !== true) return;
      this.#usageReport.serviceTier(agentId, launch, config.provider, event.state);
      // One warning per launch, on the first reading that says Fast is not actually on. A later
      // reading cannot retract it; a following launch reports its own.
      if (event.state !== AGENT_SERVICE_TIER_OBSERVED.ON && !this.#fastModeWarned.has(agentId)) {
        this.#fastModeWarned.add(agentId);
        publish(
          agentId,
          launch,
          this.#activity(
            agentId,
            AGENT_ACTIVITY_DETAIL_KIND.FAST_MODE_UNAVAILABLE,
            "warning",
            fastModeUnavailableDetail(event.state, event.reason),
          ),
        );
      }
      return;
    }
    if (event.type === "activity" || event.type === "tool-start") {
      // Providers report only WHAT happened (tool-start: name + raw input); the
      // daemon core alone decides what Activity that is, via the same
      // `toolActivity` allowlist every provider used to call for itself.
      const activity = event.type === "activity" ? event.activity : toolStartActivity(event);
      // Resumed output or a new tool call means a still-open compaction is done; report
      // that first.
      if (
        event.type === "tool-start" ||
        activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED ||
        activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED
      )
        this.#inferCompactionFinished(agentId, launch, event.conversation, {
          inferredFrom: event.type === "tool-start" ? "resumed tool use" : "resumed output",
        });
      const carriesEntries =
        activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING &&
        activity.entries?.some((entry) => entry.kind !== "tool_start");
      // A trajectory entry carrying a subagent scope (Claude parent_tool_use_id)
      // reports as subagent_activity regardless of its original detail kind, so
      // the display shows one unified "Subagent working…" signal.
      // An error stays classified as an error so it remains visible as one.
      const subagentScoped =
        activity.level !== "error" &&
        activity.entries?.some((entry) => entry.subagent !== undefined);
      publish(agentId, launch, {
        ...this.#activity(
          agentId,
          subagentScoped ? AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY : activity.detailKind,
          activity.level,
          carriesEntries
            ? ""
            : safeRuntimeActivityMessage(activity.detailKind, activity.level, activity.detail),
          { entries: activity.entries },
        ),
        ...(activity.runtimeError
          ? { runtimeError: activity.runtimeError }
          : activity.level === "error"
            ? { runtimeError: runtimeFailureDiagnostic(activity.detail) }
            : {}),
      });
      if (activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.IDLE)
        void this.drainAppInboxNotices(agentId).catch(() => {});
      return;
    }
    if (event.type === "tool-end") {
      // Every call's end reports its outcome, a call the Web hides (send_message) included, as
      // in the reference client: hiding a row is a display decision.
      const toolOutcome = launch.toolCalls?.finish(event);
      publish(
        agentId,
        launch,
        this.#activity(
          agentId,
          AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
          "info",
          "Tool finished",
          toolOutcome ? { toolOutcome } : {},
        ),
      );
      return;
    }
    const phaseEdge = PHASE_EDGES.get(event.type);
    if (phaseEdge) {
      const [phase, edge] = phaseEdge;
      if (edge === "start") this.#startPhase(phase, agentId, launch, event.conversation);
      else if (edge === "finish") this.#finishPhase(phase, agentId, launch, event.conversation);
      else this.#interruptPhase(phase, agentId, launch, event.conversation);
      return;
    }
    if (event.type === "subagent-progress") {
      // Counted whether or not its row is shown: a background task outlives its turn.
      launch.backgroundTasks?.observe(event);
      // Shown only while this launch is busy: in a turn, or after one that is waiting for its
      // background tasks (`#showQuietTurn`). Anything later would wake an idle Agent. A
      // repeat of the row just shown (one per subagent tool call) adds nothing.
      const last = this.#activityPublisher.lastBusy(agentId);
      if (last?.launch !== launch) return;
      const detail = subagentProgressDetail(event);
      if (
        last.activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY ||
        last.activity.detail !== detail
      )
        publish(
          agentId,
          launch,
          this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY, "info", detail),
        );
      // After the turn, an ended task shortens the wait, and the last one ends it Idle. Runs
      // even when the row repeated the one before, so a wait never outlives its tasks.
      if (event.taskStatus) this.#reconcileIdleTurn(agentId, launch);
      return;
    }
    if (event.type === "progress") {
      if (this.#activityPublisher.lastBusy(agentId)?.launch !== launch)
        publish(
          agentId,
          launch,
          this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS, "info", ""),
        );
      return;
    }
    // Single conversion for every provider (agent-runtime/runtime-error-activity.ts): formatting,
    // the 512-char cap, redaction, the `Error: …` entry, and runtimeError classification all live
    // there, not in the provider. Remembered on the launch so a process exit that follows without
    // an intervening `completed` can report `runtime_crashed` instead of a plain `idle` exit.
    if (event.type === "error") {
      launch.crashDetail = event;
      // Classified once here: the Activity's fallback class/reason and this failure's retry
      // decision are the same reading of the same failure.
      const classification = classifyRuntimeError(event);
      // A failure only a person can fix (re-auth, a model the plan does not include), an
      // exhausted billing balance, or a sticky model-config one ends the process and takes the
      // Agent offline — whenever in the launch it is observed.
      if (classification.takesAgentOffline) {
        this.#offlineResidency.takeOffline(
          agentId,
          launch,
          config.provider,
          this.#offlineResidency.buildActivity(
            config,
            runtimeDisplayName(config.provider),
            event,
            classification,
          ),
          {
            event: "agent_runtime:error_requires_user_action",
            errorClass: classification.errorClass,
            errorReason: classification.errorReason,
            requiredAction: classification.requiredAction,
          },
        );
        return;
      }
      // Retry policy reads that classification, never free-form provider hints.
      const { built, fence } = this.#runtimeErrorHold.noteRuntimeFailure(
        agentId,
        launch,
        event,
        classification,
      );
      // A tripped fingerprint fence is terminal residency like an action-required failure
      // (reference `applyRuntimeErrorFingerprintFence`): end the process and report inactive.
      if (fence) {
        this.#offlineResidency.takeOffline(
          agentId,
          launch,
          config.provider,
          buildRuntimeErrorFenceActivity(built, fence, event),
          {
            event: fence.event,
            errorClass: classification.errorClass,
            errorReason: "runtime_error_fenced",
            requiredAction: "none",
          },
        );
        return;
      }
      publish(
        agentId,
        launch,
        this.#activity(agentId, built.detailKind, built.level, built.detail, {
          entries: built.entries,
          runtimeError: built.runtimeError,
        }),
      );
      return;
    }
    if (event.type === "reconnecting") {
      const built = buildRuntimeReconnectingActivity(event);
      publish(
        agentId,
        launch,
        this.#activity(agentId, built.detailKind, built.level, built.detail, {
          entries: built.entries,
        }),
      );
      return;
    }
    if (event.type === "notice-undelivered") {
      // A steer-mode provider accepted this notice but later learned it never reached
      // the model (Kiro's own steering buffer discarded it, or the steer call itself was never
      // accepted). Hold the exact text for redelivery once this Agent is next idle — no ACK
      // bookkeeping here; whatever originally accepted this text already settled its own ACK (or
      // never had one, for an App Inbox notice). The tracked mentions it carried were not told:
      // that redelivery settles them, not this turn's end.
      this.#deliveryQueue.holdFallbackNotice(agentId, {
        text: event.text,
        ...(event.conversation ? { conversation: event.conversation } : {}),
        ...(event.deliveryIds?.length ? { deliveryIds: event.deliveryIds } : {}),
      });
      if (event.deliveryIds?.length)
        this.#mentionDeliveries.markUndelivered(agentId, event.deliveryIds);
      return;
    }
    if (event.type !== "completed") return;
    // Capture provider error text before clearing crashDetail for Activity wording.
    const collectorFailReason =
      event.status === "failed"
        ? (launch.crashDetail?.message ?? "Agent runtime failed.").slice(0, 2000)
        : undefined;
    this.#runtimeErrorHold.noteTurnEnd(agentId);
    // Release whatever a queue_until_idle provider held while this turn ran, as one
    // coalesced notice for the next turn — never blocking this turn-end Activity on it.
    this.#releaseTurnEndHolds(agentId);
    // Tracked mentions told during this turn end with it.
    if (!isMemoryAgentRuntime(config) || event.conversation)
      void this.#mentionDeliveries.settleTurnEnd(agentId, event.conversation?.conversationId);
    // A turn ending means a still-open compaction is done; report that before the turn's own
    // idle/failed/interrupted Activity.
    this.#inferCompactionFinished(agentId, launch, event.conversation, {
      inferredFrom: "turn end",
    });
    this.#phases.review.finish(agentId);
    // A turn outcome (of any status) resolves any error observed mid-turn; a crash wording only
    // applies to a process exit with no such outcome in between. A failed turn that already
    // showed its own runtime_error Activity this turn (`crashDetail` set by the `error` event
    // above) keeps that as the one visible reason instead of layering this generic failure
    // notice on top of it — every provider's `error`-then-`completed(failed)` pair reports
    // exactly once.
    const alreadyExplained = event.status === "failed" && launch.crashDetail !== undefined;
    launch.crashDetail = undefined;
    if (controlled)
      void runtime.session
        .readSessionIdentity?.()
        .then(async (identity) => {
          if (identity) await this.#agentSessions.update(agentId, launch.launchId, identity);
        })
        .catch(() => {});
    if (event.status === "completed") this.#showQuietTurn(agentId, launch, publish);
    else {
      if (!alreadyExplained)
        publish(
          agentId,
          launch,
          event.status === "failed"
            ? {
                ...this.#runtimeErrorActivity(agentId, "Agent runtime failed."),
                runtimeError: runtimeFailureDiagnostic("turn failure"),
              }
            : this.#interruptedActivity(agentId),
        );
      this.systemCleaner.onAgentWorkingToIdle(agentId);
    }
    if (collectorFailReason && this.#collectSkillAgents.has(agentId))
      void this.#failCollectorRunningSlots(agentId, collectorFailReason).catch(() => {});
    void this.drainAppInboxNotices(agentId).catch(() => {});
  }

  /** A phase's tracker, whose watchdog publishes the phase's stale notice to a live launch. */
  #trackPhase(phase: RuntimePhase): PhaseTracker {
    const {
      staleMs,
      stale: [detailKind, detail],
    } = RUNTIME_PHASES[phase];
    return new PhaseTracker((agentId) => {
      const launch = this.#currentActivityLaunches.get(agentId);
      if (launch)
        this.#activityPublisher.publish(
          agentId,
          launch,
          this.#activity(agentId, detailKind, "info", detail),
        );
    }, staleMs);
  }

  /** Opens a phase once, reporting its start; a repeated start while it is open reports nothing. */
  #startPhase(
    phase: RuntimePhase,
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
  ): void {
    if (this.#phases[phase].start(agentId) !== "started") return;
    this.#publishPhase(agentId, launch, RUNTIME_PHASES[phase].started, conversation);
  }

  /** Ends an open phase once on its own finish signal. */
  #finishPhase(
    phase: RuntimePhase,
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
  ): void {
    if (this.#phases[phase].finish(agentId) !== "finished") return;
    this.#publishPhase(agentId, launch, RUNTIME_PHASES[phase].finished, conversation);
  }

  /** Ends an open compaction once, before the Activity that established its completion. */
  #inferCompactionFinished(
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
    { inferredFrom }: { inferredFrom: CompactionInference },
  ): void {
    if (this.#phases.compaction.finish(agentId) !== "finished") return;
    this.#publishPhase(agentId, launch, inferredCompactionFinish(inferredFrom), conversation);
  }

  /** Ends an open phase once as interrupted, for a phase that reports interruptions. */
  #interruptPhase(
    phase: RuntimePhase,
    agentId: string,
    launch: ActivityLaunch,
    conversation: AgentRuntimeEvent["conversation"],
  ): void {
    const interrupted = RUNTIME_PHASES[phase].interrupted;
    if (!interrupted || this.#phases[phase].interrupt(agentId) !== "interrupted") return;
    this.#publishPhase(agentId, launch, interrupted, conversation);
  }

  #publishPhase(
    agentId: string,
    launch: ActivityLaunch,
    [detailKind, detail]: PhaseActivity,
    conversation: AgentRuntimeEvent["conversation"],
  ): void {
    this.#activityPublisher.publish(agentId, launch, {
      ...this.#activity(agentId, detailKind, "info", detail),
      ...(conversation
        ? { conversationId: conversation.conversationId, conversationTarget: conversation.target }
        : {}),
    });
  }

  /** Forgets one Agent's open phases and stops their watchdogs. */
  #disposePhases(agentId: string): void {
    for (const tracker of Object.values(this.#phases)) tracker.dispose(agentId);
  }

  /** Forgets every Agent's open phases; used on full daemon shutdown. */
  #disposeAllPhases(): void {
    for (const tracker of Object.values(this.#phases)) tracker.disposeAll();
  }

  /**
   * A collector turn that dies before HTTPS submit (e.g. model 405) must
   * still settle Collect Run slots — Activity alone is not a completion boundary.
   */
  async #failCollectorRunningSlots(agentId: string, failureReason: string): Promise<void> {
    const agentApiKey = this.#agentApiKeys.get(agentId);
    if (!agentApiKey || !this.#transport.agentWeeklyReportCollect) return;
    await this.#transport.agentWeeklyReportCollect(
      {
        idempotencyKey: crypto.randomUUID(),
        failRunningSlots: true,
        failureReason,
      },
      agentApiKey,
    );
  }

  #rememberUsage(snapshot: UsageSnapshot): void {
    const current = this.#observedUsage.get(snapshot.provider);
    this.#observedUsage.set(snapshot.provider, {
      ...current,
      ...snapshot,
      primary: snapshot.primary ?? current?.primary,
      secondary: snapshot.secondary ?? current?.secondary,
      // Stamped at observation time, not when `scanUsage` later reuses this snapshot as its
      // fallback — a passively observed reading is never as fresh as "now".
      collectedAt: snapshot.collectedAt ?? new Date().toISOString(),
    });
  }

  #currentObservedUsage(provider: RuntimeProvider): UsageSnapshot | undefined {
    const snapshot = this.#observedUsage.get(provider);
    if (!snapshot) return undefined;
    const now = Date.now();
    const primary = validUsageWindow(snapshot.primary, now);
    const secondary = validUsageWindow(snapshot.secondary, now);
    if (!primary && !secondary) {
      this.#observedUsage.delete(provider);
      return undefined;
    }
    const current = { ...snapshot, primary, secondary };
    this.#observedUsage.set(provider, current);
    return current;
  }

  #assertOwnIntent(intent: {
    protocolMajor: number;
    workspaceId: string;
    computerId?: string;
  }): void {
    if (intent.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR)
      throw new Error("unsupported agent protocol major");
    if (intent.workspaceId !== this.#connection.workspaceId)
      throw new Error("agent intent targets another Workspace");
    if (intent.computerId !== this.#connection.computerId)
      throw new Error("agent intent targets another Computer");
  }

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
              : this.#interruptedActivity(agentId),
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
        ...this.#startingActivity(probe.agentId),
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
      ...this.#idleActivity(probe.agentId),
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
    const delivery = this.#enqueueDelivery(message.agentId, message);
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
      this.#ensureAgentInputDrain(message.agentId);
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
    const delivery = this.#enqueueDelivery(agentId, message);
    if (this.#runnerHold !== undefined) {
      void delivery.catch(() => {});
      return Promise.resolve();
    }
    this.#ensureAgentInputDrain(agentId);
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
    const queue = this.#agentInputQueues.get(purge.agentId);
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
          this.#acknowledgeCustody(item.message);
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
    this.#closeAgentInputQueue(agentId, new Error(`Agent runtime is stopping: ${agentId}`));
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
    const stopping = this.#stopAgent(agentId)
      .catch((error) => {
        if (activityLaunch)
          this.#activityPublisher.publish(
            agentId,
            activityLaunch,
            this.#runtimeErrorActivity(agentId, this.#stopFailureMessage(agentId, error)),
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

  async #stopAgent(agentId: string): Promise<void> {
    const launch = this.#agentLaunches.get(agentId);
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    const inputDrain = this.#agentInputQueues.get(agentId)?.drain;
    // Disposal rejects input waiting for a native turn boundary. Waiting for that input (or
    // launch recovery using it) first would prevent the very disposal that releases it.
    await this.#releaseAgentRuntime(agentId, { retainLaunch: true });
    if (launch) await Promise.allSettled([launch]);
    // A provider still creating its session at Stop may register and fail cleanup afterwards.
    if (this.#agentProcessManager.isStopping(agentId)) throw new AgentProcessCleanupError();
    await this.#agentProcessManager.stop(agentId);
    if (inputDrain) await Promise.allSettled([inputDrain]);
    if (activityLaunch)
      this.#activityPublisher.publish(agentId, activityLaunch, this.#stoppedActivity(agentId));
    this.#currentActivityLaunches.delete(agentId);
  }

  /**
   * Stop's outcome depends only on the local process exiting: revoking the
   * Agent API key is fire-and-forget alongside it, so a failed or slow revoke never fails or
   * delays the Stop. A failed revoke is logged and not retried.
   */
  async #releaseAgentRuntime(
    agentId: string,
    { retainLaunch = false }: { retainLaunch?: boolean } = {},
  ): Promise<void> {
    this.#desktops.end(agentId);
    const activityLaunch = this.#currentActivityLaunches.get(agentId);
    activityLaunch?.startup?.dispose();
    void this.#revokeAgentApiKey(agentId, this.#agentApiKeys.get(agentId)).catch((error) => {
      logAgentApiKeyRevokeFailed(agentId, error);
    });
    await this.#agentProcessManager.stop(agentId);
    this.#messageAttention.clearAgent(agentId);
    // Explicit Stop discards anything a queue_until_idle provider was holding.
    this.#deliveryQueue.clearAgent(agentId);
    // An explicit Stop discards the runtime-error recovery streaks the same way — a
    // fresh start should not inherit a backoff/fence from a process that no longer exists.
    this.#runtimeErrorHold.forget(agentId);
    this.#offlineResidency.forget(agentId);
    this.#sendAgentStatus(agentId, "inactive");
    this.#activityPublisher.forgetBusy(agentId);
    if (!retainLaunch) this.#currentActivityLaunches.delete(agentId);
  }

  /** Forgets one ended launch's observation state without affecting another Agent. */
  #disposeLaunchObservations(agentId: string): void {
    this.#currentActivityLaunches.get(agentId)?.stalled?.dispose(agentId);
    this.#disposePhases(agentId);
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
    return {
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: this.#connection.workspaceId,
      agentId,
      detailKind,
      level,
      detail,
      ...extra,
    };
  }

  /**
   * Builds the one wire shape both `invalidateSession` emit sites send (previously constructed
   * twice, field by field). No control-fence fields (no `startRequestId`/`controlEpoch`, unlike
   * `AgentSessionReport`): `launchId` is always
   * present at both call sites, so there is no separate gating condition here either.
   */
  #sessionInvalidateMessage(
    agentId: string,
    provider: RuntimeProvider,
    sessionId: string,
    launchId: string,
    reason: AgentSessionInvalidateReason,
  ): AgentSessionInvalidate {
    return {
      ...this.#envelope(),
      agentId,
      provider,
      sessionId,
      daemonInstanceId: this.#runtimeInstanceId,
      launchId,
      reason,
    };
  }

  #runtimeErrorActivity(
    agentId: string,
    detail: string,
    runtimeError?: ActivityDraft["runtimeError"],
  ): ActivityDraft {
    return this.#activity(
      agentId,
      AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
      "error",
      detail,
      runtimeError ? { runtimeError } : {},
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

  #startingActivity(agentId: string): ActivityDraft {
    return this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.STARTING, "info", "Starting…");
  }

  #idleActivity(agentId: string): ActivityDraft {
    return this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.IDLE, "info", "Idle");
  }

  #stoppedActivity(agentId: string): ActivityDraft {
    return this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.STOPPED, "info", "Stopped");
  }

  /** A running turn was cut by a requested stop/restart. */
  #interruptedActivity(agentId: string): ActivityDraft {
    return this.#activity(
      agentId,
      AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
      "info",
      "Turn stopped",
    );
  }

  /** Reports runtime_interrupted when a requested stop/restart cuts a busy turn.
   * Must run before `forgetBusy`, which erases the busy evidence. */
  #interruptIfBusy(agentId: string, activityLaunch: ActivityLaunch | undefined): void {
    if (!activityLaunch) return;
    const busy = this.#activityPublisher.lastBusy(agentId);
    if (busy && busy.launch === activityLaunch)
      this.#activityPublisher.publish(agentId, activityLaunch, this.#interruptedActivity(agentId));
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
    if (waiting) {
      publish(
        agentId,
        launch,
        this.#activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY, "info", waiting),
      );
      return;
    }
    publish(agentId, launch, this.#idleActivity(agentId));
    this.systemCleaner.onAgentWorkingToIdle(agentId);
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
    this.#disposePhases(agentId);
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
    this.systemCleaner.replaceOwnerSnapshot(agentId, null);
    this.#offlineResidency.forget(agentId);
  }

  /** Presents what was kept across an exit or a runtime's end, as at idle. */
  #releaseSurvivingHolds(agentId: string): void {
    this.#flushSurvivingDeliveryQueue(agentId);
    this.#releaseHeldAppItems(agentId);
    this.#releaseFallbackNotices(agentId);
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
    this.#releaseHeldAppItems(agentId);
    this.#releaseFallbackNotices(agentId);
  }

  #sendAgentStatus(agentId: string, status: "active" | "inactive"): void {
    const clientSeq = (this.#agentStatusSequences.get(agentId) ?? 0) + 1;
    this.#agentStatusSequences.set(agentId, clientSeq);
    if (status === "active") this.#offlineResidency.forget(agentId);
    this.#transport.sendAgentStatus?.({
      ...this.#envelope(),
      agentId,
      status,
      daemonInstanceId: this.#runtimeInstanceId,
      clientSeq,
      observedAtMs: this.#startedAt,
    });
  }

  #cleanupUnconfirmed(agentId: string, error: unknown): boolean {
    return (
      error instanceof AgentProcessCleanupError || this.#agentProcessManager.isStopping(agentId)
    );
  }

  /** The error Activity for a launch that did not start: its typed reason rides `runtimeError`
   * (class `LauncherError`) beside the sentence that explains it. */
  #launchFailureActivity(
    agentId: string,
    provider: RuntimeProvider,
    error: unknown,
  ): ActivityDraft {
    if (this.#cleanupUnconfirmed(agentId, error))
      return this.#runtimeErrorActivity(agentId, CLEANUP_UNCONFIRMED);
    const { detail, runtimeError } = launchFailureActivity(error, runtimeDisplayName(provider));
    return this.#runtimeErrorActivity(agentId, detail, runtimeError);
  }

  /**
   * Reachable only for a genuine local Stop failure (the process did not exit); a revoke failure
   * no longer reaches this path (see `#releaseAgentRuntime`).
   */
  #stopFailureMessage(agentId: string, error: unknown): string {
    if (this.#cleanupUnconfirmed(agentId, error)) return CLEANUP_UNCONFIRMED;
    return "Agent runtime could not be stopped.";
  }

  /**
   * Revokes the key of an Agent process that is gone: it exited, its Stop was requested, or its
   * launch failed after the key was minted. One request, exactly then, and never again:
   * a key still in use by a running Agent is never revoked by the daemon, and
   * a revoke that fails is logged and left to the server, which invalidates every earlier key
   * of the Agent when it mints the next one.
   */
  async #revokeAgentApiKey(agentId: string, agentApiKey: string | undefined): Promise<void> {
    if (!agentApiKey) return;
    if (!this.#transport.revokeAgentApiKey) return;
    if (this.#agentApiKeys.get(agentId) === agentApiKey) this.#agentApiKeys.delete(agentId);
    await this.#transport.revokeAgentApiKey(agentApiKey);
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
    const item = await (await this.#appInbox(agentId)).upsert(input);
    await this.#notifyAppItem(agentId, item.itemId);
    return item;
  }

  async reminder(context: string, request: LocalReminderRequest, agentApiKey: string) {
    const agentId = this.#authorizedAgent(context, agentApiKey);
    if (request.operation === "ack" || request.operation === "dismiss") {
      const accepted = await this.#reminders.acknowledge(
        agentId,
        request.reminderId!,
        request.revision!,
      );
      const removed = await this.#removeAppItem(
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
      await this.#appInbox(job.ownerAgentId)
    ).upsert({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: job.reminderId, revision: String(job.version) },
      title: reminderAppInboxPreview(job.title),
      summary: reminderAppInboxSummary(job, late),
    });
    return this.#notifyAppItem(job.ownerAgentId, item.itemId);
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
      ...this.#envelope(),
      agentId,
    });
    await this.#reminders.apply(sync);
  }

  async inbox(context: string, request: LocalInboxRequest): Promise<InboxResponse> {
    this.#assertRunning();
    const agentId = this.#agentIdForContext(context);
    const inbox = await this.#appInbox(agentId);
    return {
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      entries: [
        ...this.#messageAttention.check(agentId).map((messageTarget) => ({
          kind: "message_target" as const,
          messageTarget: { ...messageTarget, flags: [...messageTarget.flags] },
        })),
        ...(await inbox.read()).map((app) => ({ kind: "app" as const, app })),
      ],
    };
  }

  async drainAppInboxNotices(agentId: string): Promise<void> {
    for (const item of (await this.#appInbox(agentId)).list())
      await this.#notifyAppItem(agentId, item.itemId);
  }

  /** Removes an App Inbox item and forgets that it was announced, so an item minted again under
   * the same id is announced again. */
  async #removeAppItem(agentId: string, itemId: string): Promise<boolean> {
    const removed = await (await this.#appInbox(agentId)).remove(itemId);
    this.#notifiedAppItems.get(agentId)?.delete(itemId);
    return removed;
  }

  #appInbox(agentId: string): Promise<AgentAppInbox> {
    const existing = this.#appInboxes.get(agentId);
    if (existing) return existing;
    const opened = AgentAppInbox.open(this.stateDirectory, this.#connection.workspaceId, agentId);
    this.#appInboxes.set(agentId, opened);
    return opened;
  }

  #agentInbox(agentId: string): AgentInboxStateMachine {
    const existing = this.#agentInboxes.get(agentId);
    if (existing) return existing;
    // The local draft state (`continue-state.json`): one file per Agent under the OS temp
    // directory, with `COFORGE_CLI_DRAFT_STATE_DIR` as the documented override. Deliberately not
    // the daemon's state directory: this is short-lived continuation state, not daemon state, and
    // tests point it at their own directory.
    const inbox = new AgentInboxStateMachine(new AgentMessageDraftStore(agentId));
    this.#agentInboxes.set(agentId, inbox);
    return inbox;
  }

  async #notifyAppItem(
    agentId: string,
    itemId: string,
    { startStopped = true }: { startStopped?: boolean } = {},
  ): Promise<boolean> {
    const notified = this.#notifiedAppItems.get(agentId) ?? new Map<string, Promise<boolean>>();
    this.#notifiedAppItems.set(agentId, notified);
    const existing = notified.get(itemId);
    if (existing) return existing;
    const pending = Promise.resolve().then(async () => {
      // An ending runtime takes no notice: it waits for the launch that follows.
      if (this.#runtimeRelease.isRecovering(agentId)) {
        this.#deliveryQueue.holdAppItem(agentId, itemId);
        return false;
      }
      let session = this.#agentProcessManager.session(agentId);
      if (!session) {
        if (!startStopped) return false;
        const wakeable = this.#agentProcessManager.restartConfig(agentId);
        if (!wakeable) return false;
        session = (
          await this.#startAgent(agentId, wakeable.config, undefined, {
            sessionId: wakeable.sessionId,
          })
        ).session;
      }
      if (!session.notify) return false;
      // A queue_until_idle provider's session/notify has no safe busy path, same as an
      // ordinary message delivery — hold this app-item notice instead of sending it now, and
      // release it (re-attempting this same call) at the next turn end.
      if (this.#deliveryQueue.shouldHold(agentId)) {
        this.#deliveryQueue.holdAppItem(agentId, itemId);
        return false;
      }
      this.#deliveryQueue.busy(agentId);
      const launch = this.#currentActivityLaunches.get(agentId);
      try {
        await session.notify("New app item available. Run coforge inbox check.");
      } finally {
        if (launch && this.#agentProcessManager.session(agentId) === session)
          this.#reconcileIdleTurn(agentId, launch);
      }
      return true;
    });
    notified.set(itemId, pending);
    try {
      const accepted = await pending;
      if (!accepted && notified.get(itemId) === pending) notified.delete(itemId);
      return accepted;
    } catch (error) {
      if (notified.get(itemId) === pending) notified.delete(itemId);
      throw error;
    }
  }

  /** Re-attempts every app-item notice `AgentDeliveryQueue` held for `agentId` — each
   * one re-checks `shouldHold` itself inside `#notifyAppItem`, so one that is still busy (e.g. a
   * coalesced delivery flush that just re-armed busy) simply re-holds itself for the next
   * release rather than being lost or sent too early. */
  #releaseHeldAppItems(agentId: string): void {
    for (const itemId of this.#deliveryQueue.releaseAppItems(agentId))
      void this.#notifyAppItem(agentId, itemId).catch(() => {});
  }

  /**
   * Redelivers every fallback notice text `AgentDeliveryQueue` held for `agentId`
   * (Kiro's `notice-undelivered` event) as a bare `session.notify` call — never through
   * `AgentMessageAttentionIndex`, since the delivery or App Inbox item this text originally came
   * from already settled its own ACK (or never had one); this call must never produce a second
   * one. If the Agent has gone busy again by the time this runs (e.g. its own steer of another
   * held text just started a fresh turn), `notify` steers this one into that turn instead of
   * losing it.
   */
  #releaseFallbackNotices(agentId: string): void {
    const notices = this.#deliveryQueue.releaseFallbackNotices(agentId);
    if (!notices.length) return;
    const session = this.#agentProcessManager.session(agentId);
    for (const { text, deliveryIds = [], conversation } of notices) {
      if (!session?.notify) {
        void this.#mentionDeliveries.settleRedelivery(agentId, deliveryIds, false);
        continue;
      }
      // The tracked mentions it carries are drained once it is accepted, so it names them again.
      const redelivery =
        deliveryIds.length || conversation
          ? session.notify(text, { deliveryIds, ...(conversation ? { conversation } : {}) })
          : session.notify(text);
      void redelivery.then(
        () => this.#mentionDeliveries.settleRedelivery(agentId, deliveryIds, true),
        (error: unknown) => {
          logger.warn("A steered notice could not be redelivered after its turn ended", {
            event: "agent.delivery_queue.fallback_notice_rejected",
            agent_id: agentId,
            error_code: diagnosticErrorName(error),
          });
          return this.#mentionDeliveries.settleRedelivery(agentId, deliveryIds, false);
        },
      );
    }
  }

  #agentIdForContext(context: string): string {
    const agentId = [...this.#agentContexts.entries()].find(([, value]) => value === context)?.[0];
    if (!agentId)
      throw new AgentPreflightError("invalid agent local context", "AGENT_CONTEXT_INVALID");
    return agentId;
  }

  #contextFor(agentId: string): string {
    const context = crypto.randomUUID();
    this.#agentContexts.set(agentId, context);
    return context;
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
    this.#dropHeldMentionsWithoutSession();
    // Copied deliberately: #ensureAgentInputDrain deletes drained queues from this very map.
    const queued = Array.from(this.#agentInputQueues.keys());
    for (const agentId of queued) this.#ensureAgentInputDrain(agentId);
    return this.busyAgents();
  }

  /** The tracked mentions a runner hold kept for an Agent that has no session and no launch in
   * flight: they name a launch that is gone, so each is settled now rather than left queued. */
  #dropHeldMentionsWithoutSession(): void {
    for (const [agentId, queue] of this.#agentInputQueues) {
      if (this.#agentProcessManager.session(agentId) || this.#agentLaunches.has(agentId)) continue;
      queue.items = queue.items.filter((item) => {
        if (
          item.kind !== "delivery" ||
          !this.#mentionDeliveries.drop(
            item.message,
            MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN,
          )
        )
          return true;
        item.completion.resolve();
        return false;
      });
    }
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
    this.#started = false;
    this.#coldIdleSweep.stop();
    this.#activityPublisher.disable();
    for (const [agentId, launch] of this.#currentActivityLaunches) {
      launch.startup?.dispose();
      launch.stalled?.dispose(agentId);
    }
    this.#disposeAllPhases();
    this.#runtimeErrorHold.disposeAll();
    this.#upgradeResults.stop();
    this.#usageReport.clear();
    this.#fastModeWarned.clear();
    for (const agentId of new Set([
      ...this.#agentInputQueues.keys(),
      ...this.#agentLaunches.keys(),
      ...this.#agentProcessManager.activeAgentIds(),
    ])) {
      this.#stoppingAgents.add(agentId);
      this.#closeAgentInputQueue(agentId, new Error("daemon runtime is stopping"));
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
    await Promise.allSettled(
      [...this.#agentInputQueues.values()].flatMap((queue) => (queue.drain ? [queue.drain] : [])),
    );
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
            ...this.#envelope(),
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
    if (shutdownError !== undefined) throw shutdownError;
  }
}

export type { CodeAgentProviderFactory, AgentRuntime, AgentRuntimeConfig, CodeAgentProvider };
export type { BusyAgentReport };
