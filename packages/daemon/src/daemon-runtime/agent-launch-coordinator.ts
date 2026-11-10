import type { AgentRuntimeConfig, AgentRuntimeEvent } from "@lrm/coforge-anvil";
import type { AgentStopRegistry } from "./agent-stop-registry";
import {
  AgentProcessManager,
  type AgentRestartConfig,
  type AgentRuntime,
} from "#src/agent-runtime/agent-process-manager";
import { createAgentDesktopHolds } from "#src/agent-runtime/agent-desktop";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentContexts } from "./agent-contexts";
import { AgentDeliveryGate } from "./agent-delivery-gate";
import { AgentFeatureSync } from "./agent-feature-sync";
import { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { AgentOfflineResidency } from "./agent-offline-residency";
import { AgentActivityPublisher, type ActivityDraft } from "./agent-activity-publisher";
import { AgentUsageReport } from "./agent-usage-report";
import { PhaseBookkeeping } from "./phase-bookkeeping";
import { ReplyIntentPublisher } from "./reply-intent-publisher";
import { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import { WakeRecycle } from "./wake-recycle";
import { agentActivityDrafts } from "./agent-activity-drafts";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentProxy, LaunchRequest } from "./runtime-launch-types";
import { resolveLaunchIdentity } from "./launch-identity";
import { ResumedEarlyCrashStreak } from "./resumed-early-crash";
import {
  connectionSessionInvalidate,
  runtimeDisplayName,
  sessionInvalidateActivityText,
} from "./session-invalidate-activity";
import { type AgentActivity, type AgentSessionInvalidateReason } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { launchAgentProcess } from "./agent-launch-process";
import {
  carriedStart,
  newlyParked,
  OwedRecovery,
  type CarriedStart,
} from "./provider-replay-recovery";
import type { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import { replayRejectedEndPlan } from "./runtime-release-plans";
import type { RuntimeRelease } from "./runtime-release";
import { noteAgentRelaunchPending } from "./agent-launch-tags";
import { getLogger } from "@logtape/logtape";
import type { AgentSessionReport } from "@lrm/coforge-sdk/internal";
import { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import { TaskIdleNudge } from "./task-idle-nudge";
import { installAgentApiKeyHealer } from "./agent-api-key-heal";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Raft's `formatSubagentsFinishedRuntimeInput`, verbatim: Codex only queues their results for
 * the next turn, so the notice says where they are and to finish the work. */
const SUBAGENTS_FINISHED_WAKE =
  "Your sub-agents have finished. Their results are above. " +
  "Continue your work with them. Complete all your work before stopping.";

type Connection = { workspaceId: string; computerId: string; workspaceRoot: string };
type Drafts = ReturnType<typeof agentActivityDrafts>;
type UnavailableActivity = { detail: string; entryText?: string };

export type AgentLaunchCoordinatorPorts = {
  connection: Connection;
  transport: () => DaemonConnectionClient;
  runtimeInstanceId: string;
  agentProcessManager: AgentProcessManager;
  /** Which Agents are stopping, and any stop still in flight. */
  stops: Pick<AgentStopRegistry, "stopping" | "pendingStop">;
  /** The Session each launch reported. */
  sessions: Pick<AgentStopRegistry, "sessionReference" | "rememberSession">;
  currentActivityLaunches: Map<string, ActivityLaunch>;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  phaseBookkeeping: PhaseBookkeeping;
  contexts: AgentContexts;
  deliveryGate: AgentDeliveryGate;
  usageReport: AgentUsageReport;
  fastModeWarned: Set<string>;
  sync: AgentFeatureSync;
  /** Applies the server-authored context-view gate for a newly fetched launch config. */
  contextViewGate: (agentId: string, enabled: boolean | undefined) => void;
  agentApiKeys: Map<string, string>;
  agentProxy?: AgentProxy;
  agentProxyTokens: Map<string, string>;
  desktops: ReturnType<typeof createAgentDesktopHolds>;
  wakeRecycle: WakeRecycle;
  collectSkillAgents: Set<string>;
  introducedAgents: Set<string>;
  messageAttention: AgentMessageAttentionIndex;
  runtimeRelease: Pick<RuntimeRelease<ActivityLaunch>, "endAndReplace">;
  agentControl: AgentControl;
  agentSessions: AgentSessions;
  runtimeErrorHold: RuntimeErrorDeliveryHold;
  replyIntents: ReplyIntentPublisher<ActivityLaunch>;
  offlineResidency: AgentOfflineResidency;
  drafts: Drafts;
  systemCleaner: SystemCleaner;
  isStopping: () => boolean;
  assertRunning: () => void;
  assertAgentNotStopping: (agentId: string) => void;
  contextFor: (agentId: string) => string;
  envelope: () => Pick<
    AgentSessionReport,
    "protocolMajor" | "requestId" | "workspaceId" | "computerId"
  >;
  reportAgentSession: (report: AgentSessionReport) => Promise<void>;
  sendAgentStatus: (agentId: string, status: "active" | "inactive") => void;
  scheduleStartupFailure: (agentId: string, launch: ActivityLaunch) => void;
  observeRuntimeEvent: (
    agentId: string,
    launch: ActivityLaunch,
    config: AgentRuntimeConfig,
    runtime: AgentRuntime,
    managed: boolean,
    event: AgentRuntimeEvent,
  ) => void;
  reconcileIdleTurn: (agentId: string, launch: ActivityLaunch) => boolean;
  activity: (
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra?: Partial<ActivityDraft>,
  ) => ActivityDraft;
  narrateUnavailable: (
    agentId: string,
    launch: ActivityLaunch,
    activity: UnavailableActivity,
  ) => void;
  disposeLaunchObservations: (agentId: string) => void;
  revokeLocalLaunch: (agentId: string, localContext?: string, proxyToken?: string) => void;
  revokeAgentApiKey: (agentId: string, apiKey: string | undefined, scope?: "all") => Promise<void>;
  launchFailureActivity: (
    agentId: string,
    provider: AgentRuntimeConfig["provider"],
    error: unknown,
  ) => ActivityDraft;
  /** The App Inbox: each launch announces its items, and a replaced Session forgets who was told. */
  appInbox: Pick<AgentInboxCoordinator, "drainAppInboxNotices" | "forgetAnnouncedAppItems">;
  /** Puts the Agent's MEMORY.md block at the front of a fresh session's queued input. */
  attachSessionMemory: (agentId: string) => Promise<boolean>;
  /** A daemon-initiated relaunch after a process exit (the resumed-session cold start): the
   * ordinary launch gate with wake bookkeeping, fire-and-forget. */
  relaunchResumed(agentId: string, restart: AgentRestartConfig, request: LaunchRequest): void;
};

export class AgentLaunchCoordinator {
  /** Launches that created their native session, not resumed one: the idle reminder asks with
   * `freshSession` once per such launch, because that session has no memory of the Tasks. */
  readonly #freshLaunches = new Set<string>();
  /** Consecutive qualifying early crashes of a resumed Session, across this runtime's launches. */
  readonly resumedEarlyCrash = new ResumedEarlyCrashStreak();
  /** What a cold start of a rejected Session still owes the Agent's next launch. */
  readonly #owed: OwedRecovery;
  /** The task idle reminder's daemon side, built from this coordinator's own collaborators. */
  readonly idleNudge: TaskIdleNudge;

  constructor(readonly ports: AgentLaunchCoordinatorPorts) {
    this.#owed = new OwedRecovery(ports.deliveryGate.inboxes);
    this.idleNudge = new TaskIdleNudge({
      ask: async (agentId, request) => {
        const agentApiKey = this.ports.agentApiKeys.get(agentId);
        if (!agentApiKey) throw new Error("Agent API key is missing");
        const transport = this.ports.transport();
        if (!transport.agentTaskIdleNudge) throw new Error("idle nudge is unavailable");
        return transport.agentTaskIdleNudge(request, agentApiKey);
      },
      idle: (agentId) => {
        const session = this.ports.agentProcessManager.session(agentId);
        return (
          session !== undefined &&
          session.hasLiveTurn === false &&
          !this.ports.deliveryGate.hasQueued(agentId) &&
          !this.ports.deliveryGate.shouldHold(agentId)
        );
      },
      backgroundTasks: (agentId) =>
        this.ports.currentActivityLaunches.get(agentId)?.backgroundTasks?.count ?? 0,
      sessionId: (agentId) => this.ports.currentActivityLaunches.get(agentId)?.launchId,
      freshSession: (agentId) => {
        const launchId = this.ports.currentActivityLaunches.get(agentId)?.launchId;
        return launchId !== undefined && this.#freshLaunches.has(launchId);
      },
      deliver: async (agentId, text) => {
        const session = this.ports.agentProcessManager.session(agentId);
        if (!session?.notify) return false;
        await session.notify(text);
        return true;
      },
    });
    // A key another launch's Stop revoked answers every Agent API call with a bare 401;
    // the shared wire transport asks this healer for a replacement and retries once.
    installAgentApiKeyHealer({
      agentApiKeys: ports.agentApiKeys,
      workspaceId: () => ports.connection.workspaceId,
      transport: () => (ports.isStopping() ? undefined : ports.transport()),
      managedScope: (agentId) => ports.agentProcessManager.serverLaunch(agentId),
      launchAlive: (agentId) =>
        ports.agentProcessManager.runningAgentIds().includes(agentId) &&
        !ports.stops.stopping(agentId) &&
        !ports.agentProcessManager.isStopping(agentId),
    });
  }

  /**
   * Writes the last-subagent wake as idle input (Raft's `sendRuntimeInput mode:idle`), under
   * the idle nudge's delivery gates: a live turn, queued work or a delivery hold drops it.
   */
  wakeFinishedSubagents(agentId: string): void {
    const session = this.ports.agentProcessManager.session(agentId);
    if (!session?.notify || session.hasLiveTurn !== false) return;
    if (this.ports.deliveryGate.hasQueued(agentId) || this.ports.deliveryGate.shouldHold(agentId))
      return;
    void session.notify(SUBAGENTS_FINISHED_WAKE).catch((error: unknown) => {
      logger.info("Subagent wake notice could not be written", {
        event: "subagent_wake:delivery_failed",
        agent_id: agentId,
        error_code: error instanceof Error ? error.name : "unknown",
      });
    });
  }

  async launchAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    request: LaunchRequest,
  ): Promise<AgentRuntime> {
    const { control } = request;
    // A daemon-initiated launch (no `control` — a wake, never a server Start) reuses
    // the last server-supplied launch identity remembered alongside this Agent's restart config,
    // instead of minting a fresh one. An Agent with no remembered identity (never brought under
    // AgentControl, or already forgotten by an explicit Stop) keeps minting, unchanged.
    const serverLaunch = control ? undefined : this.ports.agentProcessManager.serverLaunch(agentId);
    const { requestId, reference, previousLaunchId, launchId, reused, managedScope } =
      resolveLaunchIdentity({
        request,
        provider: config.provider,
        previous: this.ports.sessions.sessionReference(agentId),
        serverLaunch,
      });
    this.ports.sessions.rememberSession(agentId, reference);
    if (request.sessionId === undefined) this.#freshLaunches.add(launchId);
    const launch: ActivityLaunch = {
      launchId,
      clientSeq: reused ? this.ports.agentProcessManager.lastClientSeq(agentId) : 0,
      stopping: false,
      provider: config.provider,
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
    this.ports.currentActivityLaunches.set(agentId, launch);
    this.ports.activityPublisher.forgetBusy(agentId);
    this.ports.phaseBookkeeping.dispose(agentId);
    this.ports.contexts.newContext(agentId, config.provider);
    // This launch's delivery mode, read by AgentMessageAttentionIndex.receive via
    // #deliveryGate.shouldHold on every delivery for this Agent from now on.
    this.ports.deliveryGate.setProvider(agentId, config.provider);
    this.ports.usageReport.forget(agentId);
    this.ports.fastModeWarned.delete(agentId);
    // AgentControl's fresh retry after a kiro/pi AgentSessionRecoveryError: the invalidate was
    // already reported before this launch (see `invalidateSession` above); narrate the cold
    // start here, where the real launch's ActivityLaunch now exists. `invalidateReason` is
    // threaded explicitly through this one launch's request (see `LaunchRequest`), never a
    // side channel: it can neither outlive this launch nor attach to a later unrelated one.
    if (request.replacedSessionId && request.invalidateReason)
      this.ports.narrateUnavailable(
        agentId,
        launch,
        sessionInvalidateActivityText(
          runtimeDisplayName(config.provider),
          request.replacedSessionId,
          request.invalidateReason,
        ),
      );
    return launchAgentProcess(
      {
        ...this.ports,
        idleNudge: this.idleNudge,
        resumedEarlyCrash: this.resumedEarlyCrash,
        coldStartResumedSession: (id, ended, stale) =>
          this.#coldStartResumedSession(id, ended, stale, "repeated_early_crash"),
        coldStartRejectedReplay: (id, running, stale, started) =>
          this.#coldStartRejectedReplay(id, running, stale, started),
      },
      agentId,
      config,
      request,
      launch,
      reference,
      requestId,
      previousLaunchId,
      reused,
      managedScope,
    );
  }

  /** The provider rejected the replay of the stored Session this launch resumed, and the failed
   * turn has ended: end the live runtime through `RuntimeRelease`, then replace the Session as for
   * an early crash. The fresh Session is told what the Agent never read, read before the exit
   * clears it, what arrived while the runtime was ending, and what the launch was started with
   * (provider-replay-recovery.ts), less the tracked mentions the server issues again.
   * Whether the Session was replaced: when not, the watch stays armed for the next rejected turn. */
  async #coldStartRejectedReplay(
    agentId: string,
    launch: ActivityLaunch,
    staleSessionId: string,
    started: LaunchRequest,
  ): Promise<boolean> {
    const { ports } = this;
    const restart = ports.agentProcessManager.restartConfig(agentId);
    if (
      !restart ||
      launch.stopping ||
      ports.currentActivityLaunches.get(agentId) !== launch ||
      ports.isStopping() ||
      ports.stops.stopping(agentId)
    )
      return false;
    // Read before the exit clears the attention.
    const unread = ports.messageAttention.check(agentId);
    // A delivery held now is in `unread` too; only those held later are counted from the parking.
    const held = new Set(ports.deliveryGate.pending(agentId).map(({ deliveryId }) => deliveryId));
    return ports.runtimeRelease.endAndReplace(
      agentId,
      replayRejectedEndPlan(restart),
      (parked, carried) => {
        // The failure's backoff belongs to the process that earned it, and its error class (a
        // status code makes it a provider API one) is not one a turn's end lifts: the fresh
        // Session starts with no hold, as after a take-offline.
        ports.deliveryGate.endHoldForNextLaunch(agentId);
        ports.runtimeErrorHold.forget(agentId);
        // The fresh Session was told of none of the items the dead one was told of.
        ports.appInbox.forgetAnnouncedAppItems(agentId);
        this.#coldStartResumedSession(
          agentId,
          launch,
          staleSessionId,
          "provider_replay_rejected",
          carriedStart(started, unread, newlyParked(parked, held), carried),
        );
      },
    );
  }

  /** Drops what the Agent was owed: a Stop a person made, or the Agent's delete. */
  dropOwedRecovery(agentId: string): void {
    this.#owed.drop(agentId);
  }

  /** Drops every debt, as a whole-runtime stop does: the cloud's next Start is the source then. */
  clearOwedRecovery(): void {
    this.#owed.clear();
  }

  /** What the Agent's next launch still owes a cold start that did not finish telling it, and the
   * call that settles the debt once that launch has told it. */
  owedTo(agentId: string) {
    return this.#owed.owing(agentId, this.ports.deliveryGate.pending(agentId));
  }

  /** A stored Session that cannot be continued: invalidate it and cold-start a fresh Session
   * through the ordinary launch gate, so queued deliveries carry over and no later wake can pick
   * the stale Session back up. Two early crashes of a resumed Session within seconds, which the
   * provider cannot report as corrupt (resumed-early-crash.ts; Raft 1.0.63
   * `repeated_early_crash`), and a provider that rejects its replay
   * (provider-replay-recovery.ts) both come here, after the runtime is gone. What a rejected replay
   * `carried` is owed to the Agent's next launch until one has told it. */
  #coldStartResumedSession(
    agentId: string,
    launch: ActivityLaunch,
    staleSessionId: string,
    reason: AgentSessionInvalidateReason,
    carried?: CarriedStart,
  ): void {
    const restart = this.ports.agentProcessManager.restartConfig(agentId);
    if (!restart || this.ports.isStopping() || this.ports.stops.stopping(agentId)) return;
    const reference = this.ports.sessions.sessionReference(agentId);
    this.ports.transport().sendSessionInvalidate?.(
      connectionSessionInvalidate(this.ports.connection, this.ports.runtimeInstanceId, {
        agentId,
        provider: restart.config.provider,
        sessionId: staleSessionId,
        launchId: reference?.launchId ?? launch.launchId,
        reason,
      }),
    );
    if (reference)
      this.ports.sessions.rememberSession(agentId, {
        ...reference,
        sessionId: undefined,
        sessionMode: "create",
      });
    this.ports.agentProcessManager.clearRestartSession(agentId);
    if (carried) this.#owed.owe(agentId, carried);
    // The exit that triggered this cold start must not sweep the strays the relaunch keeps
    // using; the mark clears when the new launch registers its tag token (task #673).
    noteAgentRelaunchPending(agentId);
    this.ports.relaunchResumed(agentId, restart, {
      sessionMode: "create",
      replacedSessionId: staleSessionId,
      invalidateReason: reason,
    });
  }
}
