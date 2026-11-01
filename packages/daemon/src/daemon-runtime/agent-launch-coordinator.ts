import type { AgentRuntimeConfig, AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { AgentProcessManager, type AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import { createAgentDesktopHolds } from "#src/agent-runtime/agent-desktop";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentContexts } from "./agent-contexts";
import { AgentDeliveryQueue } from "./agent-delivery-queue";
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
import { resolveLaunchIdentity, type SessionReference } from "./launch-identity";
import { runtimeDisplayName, sessionInvalidateActivityText } from "./session-invalidate-activity";
import { type AgentActivity } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { launchAgentProcess } from "./agent-launch-process";
import { getLogger } from "@logtape/logtape";
import type { AgentSessionReport } from "@lrm/coforge-sdk/internal";
import { SystemCleaner } from "#src/system-cleaner/system-cleaner";

const logger = getLogger(["coforge", "daemon", "runtime"]);

type Connection = { workspaceId: string; computerId: string; workspaceRoot: string };
type Drafts = ReturnType<typeof agentActivityDrafts>;
type UnavailableActivity = { detail: string; entryText?: string };

export type AgentLaunchCoordinatorPorts = {
  connection: Connection;
  transport: () => DaemonConnectionClient;
  runtimeInstanceId: string;
  agentProcessManager: AgentProcessManager;
  sessionReferences: Map<string, SessionReference>;
  currentActivityLaunches: Map<string, ActivityLaunch>;
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  phaseBookkeeping: PhaseBookkeeping;
  contexts: AgentContexts;
  deliveryQueue: AgentDeliveryQueue;
  usageReport: AgentUsageReport;
  fastModeWarned: Set<string>;
  sync: AgentFeatureSync;
  agentApiKeys: Map<string, string>;
  agentProxy?: AgentProxy;
  agentProxyTokens: Map<string, string>;
  desktops: ReturnType<typeof createAgentDesktopHolds>;
  wakeRecycle: WakeRecycle;
  stoppingAgents: Set<string>;
  collectSkillAgents: Set<string>;
  introducedAgents: Set<string>;
  messageAttention: AgentMessageAttentionIndex;
  agentControl: AgentControl;
  agentSessions: AgentSessions;
  runtimeErrorHold: RuntimeErrorDeliveryHold;
  replyIntents: ReplyIntentPublisher<ActivityLaunch>;
  offlineResidency: AgentOfflineResidency;
  drafts: Drafts;
  systemCleaner: SystemCleaner;
  agentStops: Map<string, Promise<void>>;
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
  revokeAgentApiKey: (agentId: string, apiKey: string | undefined) => Promise<void>;
  launchFailureActivity: (
    agentId: string,
    provider: AgentRuntimeConfig["provider"],
    error: unknown,
  ) => ActivityDraft;
  drainAppInboxNotices: (agentId: string) => Promise<void>;
};

export function createAgentLaunchCoordinator(
  ports: AgentLaunchCoordinatorPorts,
): AgentLaunchCoordinator {
  return new AgentLaunchCoordinator(ports);
}

export class AgentLaunchCoordinator {
  constructor(readonly ports: AgentLaunchCoordinatorPorts) {}

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
        previous: this.ports.sessionReferences.get(agentId),
        serverLaunch,
      });
    this.ports.sessionReferences.set(agentId, reference);
    const launch: ActivityLaunch = {
      launchId,
      clientSeq: reused ? this.ports.agentProcessManager.lastClientSeq(agentId) : 0,
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
    this.ports.currentActivityLaunches.set(agentId, launch);
    this.ports.activityPublisher.forgetBusy(agentId);
    this.ports.phaseBookkeeping.dispose(agentId);
    this.ports.contexts.newContext(agentId, config.provider);
    // This launch's delivery mode, read by AgentMessageAttentionIndex.receive via
    // #deliveryQueue.shouldHold on every delivery for this Agent from now on.
    this.ports.deliveryQueue.setProvider(agentId, config.provider);
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
      this.ports,
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
}
