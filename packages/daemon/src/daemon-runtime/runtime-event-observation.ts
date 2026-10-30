import {
  AGENT_ACTIVITY_DETAIL_KIND,
  AGENT_SERVICE_TIER_OBSERVED,
  type AgentActivity,
} from "@lrm/coforge-sdk/internal";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type UsageSnapshot,
} from "@lrm/coforge-anvil";
import { isMemoryAgentRuntime } from "@coforge/agent";
import type { AgentSessions } from "#src/agent-runtime/agent-session";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import { classifyRuntimeError } from "#src/agent-runtime/runtime-error-classification";
import { endsStalledTurn, stalledTurnObservation } from "./stalled-turn-indicator";
import {
  buildRuntimeErrorFenceActivity,
  buildRuntimeReconnectingActivity,
} from "#src/agent-runtime/runtime-error-activity";
import { runtimeDisplayName } from "./session-invalidate-activity";
import { subagentProgressDetail } from "#src/agent-runtime/subagent-progress-activity";
import { PHASE_EDGES } from "#src/agent-runtime/runtime-phases";
import { runtimeFailureDiagnostic, safeRuntimeActivityMessage } from "./runtime-activity-text";
import { toolStartActivity } from "#src/code-agent/tool-activity";
import { fastModeUnavailableDetail } from "./fast-mode-activity";
import type { ActivityLaunch } from "./activity-launch";
import type { ActivityDraft, PublishedActivityLaunch } from "./agent-activity-publisher";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import type { AgentUsageReport } from "./agent-usage-report";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { PhaseBookkeeping } from "./phase-bookkeeping";
import type { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import type { SystemCleaner } from "#src/system-cleaner/system-cleaner";

type Publish = (id: string, source: PublishedActivityLaunch, activity: ActivityDraft) => void;

/** Everything the observation reads or writes that belongs to the runtime: existing collaborators
 * pass through by reference, one-off helpers arrive as functions. No daemon state is copied. */
export type RuntimeEventObservationPorts = Readonly<{
  activityPublisher: AgentActivityPublisher<ActivityLaunch>;
  deliveryQueue: AgentDeliveryQueue;
  offlineResidency: AgentOfflineResidency;
  usageReport: AgentUsageReport;
  phaseBookkeeping: PhaseBookkeeping;
  runtimeErrorHold: RuntimeErrorDeliveryHold;
  mentionDeliveries: MentionDeliveryTracker;
  agentSessions: AgentSessions;
  systemCleaner: SystemCleaner;
  collectSkillAgents: ReadonlySet<string>;
  fastModeWarned: Set<string>;
  isWorking(agentId: string): boolean;
  activityDraft(
    agentId: string,
    detailKind: AgentActivity["detailKind"],
    level: AgentActivity["level"],
    detail: string,
    extra?: Partial<ActivityDraft>,
  ): ActivityDraft;
  runtimeErrorActivity(agentId: string, message: string): ActivityDraft;
  interruptedActivity(agentId: string): ActivityDraft;
  showQuietTurn(agentId: string, launch: ActivityLaunch, publish: Publish): void;
  reconcileIdleTurn(agentId: string, launch: ActivityLaunch): boolean;
  rememberUsage(snapshot: UsageSnapshot): void;
  releaseTurnEndHolds(agentId: string): void;
  drainAppInboxNotices(agentId: string): Promise<void>;
  failCollectorRunningSlots(agentId: string, failureReason: string): Promise<void>;
}>;

/**
 * One provider runtime event, observed against a live launch: what Activity it becomes, what it
 * does to delivery gating, phase bookkeeping, usage reporting, and turn-end settlement. A late
 * event from a replaced launch mutates nothing — the caller's launch check decided that first.
 */
export function observeRuntimeEvent(
  ports: RuntimeEventObservationPorts,
  agentId: string,
  launch: ActivityLaunch,
  config: AgentRuntimeConfig,
  runtime: AgentRuntime,
  controlled: boolean,
  event: AgentRuntimeEvent,
): void {
  const publish: Publish = (id, source, activity) =>
    ports.activityPublisher.publish(id, source, {
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
    ports.deliveryQueue.busy(agentId);
  if (endsStalledTurn(event, runtime.session.hasLiveTurn)) launch.stalled?.finish(agentId);
  else if (ports.isWorking(agentId) || runtime.session.hasLiveTurn === true)
    launch.stalled?.observe(agentId, stalledTurnObservation(launch));
  if (event.type === "session") {
    if (controlled && !event.conversation)
      void ports.agentSessions.update(agentId, launch.launchId, event.identity).catch(() => {});
    return;
  }
  if (event.type === AGENT_RUNTIME_EVENT_TYPE.USAGE) {
    if (event.snapshot.provider === config.provider) ports.rememberUsage(event.snapshot);
    return;
  }
  if (event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE) {
    ports.usageReport.contextUsage(
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
    ports.usageReport.serviceTier(agentId, launch, config.provider, event.state);
    // One warning per launch, on the first reading that says Fast is not actually on. A later
    // reading cannot retract it; a following launch reports its own.
    if (event.state !== AGENT_SERVICE_TIER_OBSERVED.ON && !ports.fastModeWarned.has(agentId)) {
      ports.fastModeWarned.add(agentId);
      publish(
        agentId,
        launch,
        ports.activityDraft(
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
      ports.phaseBookkeeping.inferCompactionFinished(agentId, launch, event.conversation, {
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
      activity.level !== "error" && activity.entries?.some((entry) => entry.subagent !== undefined);
    publish(agentId, launch, {
      ...ports.activityDraft(
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
      void ports.drainAppInboxNotices(agentId).catch(() => {});
    return;
  }
  if (event.type === "tool-end") {
    // Every call's end reports its outcome, a call the Web hides (send_message) included, as
    // in the reference client: hiding a row is a display decision.
    const toolOutcome = launch.toolCalls?.finish(event);
    publish(
      agentId,
      launch,
      ports.activityDraft(
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
    if (edge === "start") ports.phaseBookkeeping.start(phase, agentId, launch, event.conversation);
    else if (edge === "finish")
      ports.phaseBookkeeping.finish(phase, agentId, launch, event.conversation);
    else ports.phaseBookkeeping.interrupt(phase, agentId, launch, event.conversation);
    return;
  }
  if (event.type === "subagent-progress") {
    // Counted whether or not its row is shown: a background task outlives its turn.
    launch.backgroundTasks?.observe(event);
    // Shown only while this launch is busy: in a turn, or after one that is waiting for its
    // background tasks (`#showQuietTurn`). Anything later would wake an idle Agent. A
    // repeat of the row just shown (one per subagent tool call) adds nothing.
    const last = ports.activityPublisher.lastBusy(agentId);
    if (last?.launch !== launch) return;
    const detail = subagentProgressDetail(event);
    if (
      last.activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY ||
      last.activity.detail !== detail
    )
      publish(
        agentId,
        launch,
        ports.activityDraft(agentId, AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY, "info", detail),
      );
    // After the turn, an ended task shortens the wait, and the last one ends it Idle. Runs
    // even when the row repeated the one before, so a wait never outlives its tasks.
    if (event.taskStatus) ports.reconcileIdleTurn(agentId, launch);
    return;
  }
  if (event.type === "progress") {
    if (ports.activityPublisher.lastBusy(agentId)?.launch !== launch)
      publish(
        agentId,
        launch,
        ports.activityDraft(agentId, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS, "info", ""),
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
      ports.offlineResidency.takeOffline(
        agentId,
        launch,
        config.provider,
        ports.offlineResidency.buildActivity(
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
    const { built, fence } = ports.runtimeErrorHold.noteRuntimeFailure(
      agentId,
      launch,
      event,
      classification,
    );
    // A tripped fingerprint fence is terminal residency like an action-required failure
    // (reference `applyRuntimeErrorFingerprintFence`): end the process and report inactive.
    if (fence) {
      ports.offlineResidency.takeOffline(
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
      ports.activityDraft(agentId, built.detailKind, built.level, built.detail, {
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
      ports.activityDraft(agentId, built.detailKind, built.level, built.detail, {
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
    ports.deliveryQueue.holdFallbackNotice(agentId, {
      text: event.text,
      ...(event.conversation ? { conversation: event.conversation } : {}),
      ...(event.deliveryIds?.length ? { deliveryIds: event.deliveryIds } : {}),
    });
    if (event.deliveryIds?.length)
      ports.mentionDeliveries.markUndelivered(agentId, event.deliveryIds);
    return;
  }
  if (event.type !== "completed") return;
  // Capture provider error text before clearing crashDetail for Activity wording.
  const collectorFailReason =
    event.status === "failed"
      ? (launch.crashDetail?.message ?? "Agent runtime failed.").slice(0, 2000)
      : undefined;
  ports.runtimeErrorHold.noteTurnEnd(agentId);
  // Release whatever a queue_until_idle provider held while this turn ran, as one
  // coalesced notice for the next turn — never blocking this turn-end Activity on it.
  ports.releaseTurnEndHolds(agentId);
  // Tracked mentions told during this turn end with it.
  if (!isMemoryAgentRuntime(config) || event.conversation)
    void ports.mentionDeliveries.settleTurnEnd(agentId, event.conversation?.conversationId);
  // A turn ending means a still-open compaction is done; report that before the turn's own
  // idle/failed/interrupted Activity.
  ports.phaseBookkeeping.inferCompactionFinished(agentId, launch, event.conversation, {
    inferredFrom: "turn end",
  });
  ports.phaseBookkeeping.closeSilently("review", agentId);
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
        if (identity) await ports.agentSessions.update(agentId, launch.launchId, identity);
      })
      .catch(() => {});
  if (event.status === "completed") ports.showQuietTurn(agentId, launch, publish);
  else {
    if (!alreadyExplained)
      publish(
        agentId,
        launch,
        event.status === "failed"
          ? {
              ...ports.runtimeErrorActivity(agentId, "Agent runtime failed."),
              runtimeError: runtimeFailureDiagnostic("turn failure"),
            }
          : ports.interruptedActivity(agentId),
      );
    ports.systemCleaner.onAgentWorkingToIdle(agentId);
  }
  if (collectorFailReason && ports.collectSkillAgents.has(agentId))
    void ports.failCollectorRunningSlots(agentId, collectorFailReason).catch(() => {});
  void ports.drainAppInboxNotices(agentId).catch(() => {});
}
