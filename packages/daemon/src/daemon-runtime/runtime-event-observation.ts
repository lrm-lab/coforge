import { AGENT_ACTIVITY_DETAIL_KIND, AGENT_SERVICE_TIER_OBSERVED } from "@lrm/coforge-sdk/internal";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
} from "@lrm/coforge-anvil";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import { classifyRuntimeError } from "#src/agent-runtime/runtime-error-classification";
import { credentialInvalidReason } from "#src/agent-runtime/credential-invalid";
import {
  endsStalledTurn,
  isTurnNeutralEvent,
  showsTurnWork,
  stalledTurnObservation,
} from "./stalled-turn-indicator";
import {
  buildRuntimeErrorFenceActivity,
  buildRuntimeReconnectingActivity,
} from "#src/agent-runtime/runtime-error-activity";
import { runtimeDisplayName } from "./session-invalidate-activity";
import { subagentProgressDetail } from "#src/agent-runtime/subagent-progress-activity";
import { SubagentWakeTracker } from "#src/agent-runtime/subagent-progress-activity";
import {
  compactionInterruption,
  compactionTokens,
  PHASE_EDGES,
} from "#src/agent-runtime/runtime-phases";
import { runtimeFailureDiagnostic, safeRuntimeActivityMessage } from "./runtime-activity-text";
import { toolStartActivity } from "#src/code-agent/tool-activity";
import { noteTurnFinished } from "./turn-boundaries";
import { fastModeUnavailableDetail } from "./fast-mode-activity";
import type { ActivityLaunch } from "./activity-launch";
import type { Publish, RuntimeEventObservationPorts } from "./runtime-event-observation-ports";
export function observeRuntimeEvent(
  ports: RuntimeEventObservationPorts,
  agentId: string,
  launch: ActivityLaunch,
  config: AgentRuntimeConfig,
  runtime: AgentRuntime,
  controlled: boolean,
  event: AgentRuntimeEvent,
): void {
  ports.deliveryGate.consumption.observeRuntimeEvent(agentId, launch.launchId, launch, event);
  launch.timing?.phase("first_activity");
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
  if (
    event.type !== "session" &&
    event.type !== "usage" &&
    event.type !== "completed" &&
    runtime.session.hasLiveTurn !== false
  )
    ports.deliveryGate.busy(agentId);
  if (endsStalledTurn(event, runtime.session.hasLiveTurn))
    launch.stalled?.finish(agentId, `event:${event.type}`);
  else if (
    !isTurnNeutralEvent(event) &&
    (showsTurnWork(event) || ports.isWorking(agentId) || runtime.session.hasLiveTurn === true)
  )
    launch.stalled?.observe(agentId, stalledTurnObservation(launch));
  if (event.type === "session") {
    if (controlled && !event.conversation)
      void ports.agentSessions.update(agentId, launch.launchId, event.identity).catch(() => {});
    return;
  }
  if (event.type === AGENT_RUNTIME_EVENT_TYPE.USAGE) {
    if (event.snapshot.provider === config.provider) ports.rememberUsage(agentId, event.snapshot);
    return;
  }
  if (event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE) {
    if (!event.conversation && event.usedTokens > 0) {
      launch.lastContextTokens = event.usedTokens;
      if (!launch.stopping)
        ports.sessionSummary?.contextUsage(
          agentId,
          config.provider,
          event.usedTokens,
          event.windowTokens,
          event.occurredAt,
        );
    }
    const recorded = ports.usageReport.contextUsage(
      agentId,
      launch,
      config.provider,
      event.usedTokens,
      event.windowTokens,
      event.occurredAt,
    );
    if (recorded) ports.phaseBookkeeping.contextUsageObserved(agentId);
    return;
  }
  if (event.type === AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER) {
    if (config.fastMode !== true) return;
    ports.usageReport.serviceTier(agentId, launch, config.provider, event.state);
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
    if (event.type === "tool-start" && !event.conversation)
      ports.deliveryGate?.wakeLoop?.noteToolCall(agentId);
    const activity = event.type === "activity" ? event.activity : toolStartActivity(event);
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
    if (!event.conversation) ports.deliveryGate?.wakeLoop?.noteToolCall(agentId);
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
    else if (edge === "finish") {
      if (event.type === "compaction-finished" && !event.conversation) {
        launch.lastContextTokens =
          event.tokensAfter !== undefined && event.tokensAfter > 0 ? event.tokensAfter : undefined;
        if (!launch.stopping)
          ports.sessionSummary?.compaction(
            agentId,
            config.provider,
            event.tokensAfter,
            event.windowTokens,
          );
      }
      ports.phaseBookkeeping.finish(
        phase,
        agentId,
        launch,
        event.conversation,
        compactionTokens(event),
      );
    } else
      ports.phaseBookkeeping.interrupt(
        phase,
        agentId,
        launch,
        event.conversation,
        compactionInterruption(event),
      );
    return;
  }
  if (event.type === "subagent-progress") {
    launch.backgroundTasks?.observe(event);
    if (runtime.session.wakesAfterSubagents === true) {
      const quiet = runtime.session.hasLiveTurn === false;
      if (quiet && event.taskStatus && event.taskId) {
        const wake = (launch.subagentWake ??= new SubagentWakeTracker());
        wake.noteTerminal(event.taskId, event.taskStatus);
      }
      if (
        quiet &&
        !launch.lastTurnInterrupted &&
        event.taskStatus &&
        launch.backgroundTasks?.count === 0 &&
        launch.subagentWake?.takeWake()
      )
        ports.wakeFinishedSubagents?.(agentId);
    }
    const last = ports.activityPublisher.lastBusy(agentId);
    if (last?.launch !== launch) return;
    if (event.taskKind === "command" || event.taskKind === "other") {
      if (event.taskStatus) ports.reconcileIdleTurn(agentId, launch);
      return;
    }
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
  if (event.type === "error") {
    if (launch.stopping) return;
    launch.crashDetail = event;
    ports.phaseBookkeeping.compactionError(agentId, launch, event.message);
    const classification = classifyRuntimeError(event);
    const credentialInvalid = credentialInvalidReason(classification);
    if (credentialInvalid || classification.takesAgentOffline) {
      const built = ports.offlineResidency.buildActivity(
        config,
        runtimeDisplayName(config.provider),
        event,
        classification,
      );
      if (credentialInvalid) {
        ports.credentialHolds.record(agentId, config, credentialInvalid);
        publish(
          agentId,
          launch,
          ports.activityDraft(agentId, built.detailKind, built.level, built.detail, {
            entries: built.entries,
            runtimeError: built.runtimeError,
          }),
        );
      } else
        ports.offlineResidency.takeOffline(agentId, launch, config.provider, built, {
          event: "agent_runtime:error_not_retryable",
          errorClass: classification.errorClass,
          errorReason: classification.errorReason,
        });
      return;
    }
    const { built, fence } = ports.runtimeErrorHold.noteRuntimeFailure(
      agentId,
      launch,
      event,
      classification,
    );
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
    ports.deliveryGate.holdFallbackNotice(agentId, {
      text: event.text,
      ...(event.conversation ? { conversation: event.conversation } : {}),
      ...(event.deliveryIds?.length ? { deliveryIds: event.deliveryIds } : {}),
    });
    if (event.deliveryIds?.length)
      ports.mentionDeliveries.markUndelivered(agentId, event.deliveryIds);
    return;
  }
  if (event.type !== "completed") return;
  let effectiveStatus = event.status;
  if (!event.conversation) {
    if (
      typeof runtime.session.hasLiveTurn === "boolean" &&
      (launch.backgroundTasks?.count ?? 0) === 0
    ) {
      const zeroEvidence = launch.turnEvidence?.finish(event.status);
      if (zeroEvidence) {
        observeRuntimeEvent(ports, agentId, launch, config, runtime, controlled, zeroEvidence);
        effectiveStatus = "failed";
      }
    } else {
      launch.turnEvidence?.reset();
    }
    if (!launch.stopping) ports.sessionSummary?.turnCompleted(agentId, config.provider);
    ports.deliveryGate?.wakeLoop?.noteTurnCompleted(agentId, { status: effectiveStatus });
  }
  noteTurnFinished(agentId, effectiveStatus, event.conversation?.conversationId);
  launch.lastTurnInterrupted = effectiveStatus === "interrupted";
  const collectorFailReason =
    effectiveStatus === "failed"
      ? (launch.crashDetail?.message ?? "Agent runtime failed.").slice(0, 2000)
      : undefined;
  ports.runtimeErrorHold.noteTurnEnd(agentId);
  ports.mentionDeliveries.settleTurnEnd(agentId, event.conversation?.conversationId);
  ports.releaseTurnEndHolds(agentId);
  ports.phaseBookkeeping.inferCompactionFinished(agentId, launch, event.conversation, {
    inferredFrom: "turn end",
  });
  ports.phaseBookkeeping.closeSilently("review", agentId);
  ports.phaseBookkeeping.turnEnded(agentId);
  const alreadyExplained = effectiveStatus === "failed" && launch.crashDetail !== undefined;
  launch.crashDetail = undefined;
  if (controlled)
    void runtime.session
      .readSessionIdentity?.()
      .then(async (identity) => {
        if (identity) await ports.agentSessions.update(agentId, launch.launchId, identity);
      })
      .catch(() => {});
  if (effectiveStatus === "completed") ports.showQuietTurn(agentId, launch, publish);
  else {
    if (!alreadyExplained)
      publish(
        agentId,
        launch,
        effectiveStatus === "failed"
          ? {
              ...ports.runtimeErrorActivity(agentId, "Agent runtime failed."),
              runtimeError: runtimeFailureDiagnostic("turn failure"),
            }
          : ports.interruptedActivity(agentId),
      );
    ports.systemCleaner.onAgentWorkingToIdle(agentId);
    ports.idleNudge?.maybeAsk(agentId);
    void ports.configApply?.settle(agentId);
  }
  if (collectorFailReason && ports.collectSkillAgents.has(agentId))
    void ports.failCollectorRunningSlots(agentId, collectorFailReason).catch(() => {});
  void ports.drainAppInboxNotices(agentId).catch(() => {});
}
