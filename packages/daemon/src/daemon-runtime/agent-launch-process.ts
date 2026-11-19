import { AgentAuthorizationError } from "#src/agent-runtime/launch-failure";
import { agentStartup } from "#src/agent-runtime/agent-startup";
import { agentRuntimeContextEnvironment } from "#src/code-agent/environment";
import { parseAssignedSkillPacks } from "#src/code-agent/assigned-skills";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { openLaunchSessionMemory } from "./session-memory-launch";
import { assertSessionNotSpent } from "./session-reset-guard";
import { LaunchPhaseTiming } from "./launch-phase-timing";
import { sessionIdReporter } from "./launch-session-report";
import { trackAgentLaunch } from "./agent-launch-tracking";
import { buildRuntimeCrashedActivity } from "#src/agent-runtime/runtime-error-activity";
import { TURN_ACTIVITY_EVENT_TYPES } from "#src/agent-runtime/runtime-phases";
import { runtimeErrorRecoverySignal } from "#src/agent-runtime/runtime-error-recovery";
import { RUNTIME_ERROR_CLASS } from "#src/agent-runtime/runtime-error-vocabulary";
import {
  buildExitStreakActivity,
  EXIT_STREAK_CAP,
  isUncleanExit,
  type ExitStreak,
} from "./exit-streak";
import {
  isMainSessionModelOutput,
  ResumedEarlyCrashWatch,
  type ResumedEarlyCrashStreak,
} from "./resumed-early-crash";
import { ProviderReplayWatch } from "./provider-replay-recovery";
import { isBusyActivityDetailKind } from "./agent-activity-publisher";
import { reportLaunchFailure } from "./agent-startup-failure";
import { ignoredAgentEnvironmentActivity } from "./agent-environment-activity";
import { requestAgentLaunchConfig } from "./agent-launch-config";
import { agentLaunchTag } from "#src/platform/agent-launch-tag";
import {
  agentRelaunchPending,
  claimAgentLaunchTagSweep,
  clearAgentLaunchTag,
  setAgentLaunchTag,
  sweepAgentLaunchTagStrays,
} from "./agent-launch-tags";
import { restoreSupersededAgentApiKey } from "./agent-api-key-revoke";
import { restoreSupersededProxyToken } from "./agent-launch-revocation";
import { wakeReusedAgent } from "./agent-wake-control";
import { logAgentApiKeyRevokeFailed } from "./agent-failure-logs";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { ActivityLaunch } from "./activity-launch";
import type { LaunchRequest } from "./runtime-launch-types";
import type { SessionReference } from "./launch-identity";
import type { AgentLaunchCoordinatorPorts } from "./agent-launch-coordinator";
import type { TaskIdleNudge } from "./task-idle-nudge";
export async function launchAgentProcess(
  ports: AgentLaunchCoordinatorPorts & {
    idleNudge?: Pick<TaskIdleNudge, "maybeAsk">;
    resumedEarlyCrash: ResumedEarlyCrashStreak;
    exitStreak: ExitStreak;
    coldStartResumedSession(agentId: string, launch: ActivityLaunch, staleSessionId: string): void;
    coldStartRejectedReplay(
      agentId: string,
      launch: ActivityLaunch,
      staleSessionId: string,
      started: LaunchRequest,
    ): Promise<boolean>;
  },
  agentId: string,
  config: AgentRuntimeConfig,
  request: LaunchRequest,
  launch: ActivityLaunch,
  reference: SessionReference,
  requestId: string,
  previousLaunchId: string | undefined,
  reused: boolean,
  managedScope:
    | {
        controlEpoch?: number;
        requestId: string;
        launchId: string;
      }
    | undefined,
): Promise<AgentRuntime> {
  const { control } = request;
  const current = () => ports.currentActivityLaunches.get(agentId) === launch && !launch.stopping;
  const timing = new LaunchPhaseTiming({
    agentId,
    launchId: launch.launchId,
    provider: config.provider,
  });
  launch.timing = timing;
  timing.phase("admitted");
  let agentApiKey: string | undefined;
  let priorAgentApiKey: string | undefined;
  let priorProxyToken: string | undefined;
  let launchTagToken = "";
  let proxyToken: string | undefined;
  let issuedProxyToken = false;
  let localContext: string | undefined;
  try {
    const launchConfig = await requestAgentLaunchConfig(
      ports.transport(),
      ports.connection.workspaceId,
      agentId,
      managedScope,
    ).catch((error: unknown) => {
      throw new AgentAuthorizationError(error);
    });
    agentApiKey = launchConfig.agentApiKey;
    timing.phase("config");
    ports.sync.launched(agentId, launchConfig.identity);
    ports.contextViewGate(agentId, launchConfig.identity?.features?.agentContextView);
    ports.assertRunning();
    ports.assertAgentNotStopping(agentId);
    const skipped = ignoredAgentEnvironmentActivity(
      { workspaceId: ports.connection.workspaceId, agentId },
      launchConfig.envVars,
      config.provider,
    );
    if (skipped) ports.activityPublisher.publish(agentId, launch, skipped);
    priorAgentApiKey = ports.agentApiKeys.get(agentId);
    ports.agentApiKeys.set(agentId, agentApiKey);
    priorProxyToken = ports.agentProxyTokens.get(agentId);
    proxyToken = ports.agentProxy?.issue(agentId, agentApiKey);
    if (proxyToken) ports.agentProxyTokens.set(agentId, proxyToken);
    issuedProxyToken = proxyToken !== undefined && proxyToken !== priorProxyToken;
    localContext = proxyToken ?? ports.contextFor(agentId);
    const desktopEnvironment = await ports.desktops.hold(agentId);
    const workspaceDirectory = agentWorkspaceDirectory(
      ports.connection.workspaceRoot,
      ports.connection.workspaceId,
      agentId,
    );
    const recycled = request.replacedSessionId
      ? undefined
      : await ports.wakeRecycle.plan({
          agentId,
          provider: config.provider,
          envVars: launchConfig.envVars,
          sessionId: reference.sessionId,
          sessionMode: reference.sessionMode,
          hasResumePrompt: request.resumePrompt !== undefined,
          agentWorkspaceDirectory: workspaceDirectory,
        });
    const recycledSessionId = recycled ? reference.sessionId : undefined;
    if (recycled) ports.narrateUnavailable(agentId, launch, { detail: recycled.activityText });
    const requestedSessionId = recycled ? undefined : reference.sessionId;
    const resumedSessionId = reference.sessionMode === "create" ? undefined : requestedSessionId;
    ports.contexts.noteSession(agentId, requestedSessionId, config.model);
    assertSessionNotSpent({
      agentId,
      provider: config.provider,
      needsReset: ports.contexts.needsSessionReset(agentId),
    });
    const sessionIds = sessionIdReporter(ports, {
      agentId,
      provider: config.provider,
      launch,
      current,
      reference,
      request,
      recycled: recycled !== undefined,
      recycledSessionId,
      previousLaunchId,
      timing,
    });
    const earlyCrashWatch = new ResumedEarlyCrashWatch();
    launchTagToken = crypto.randomUUID();
    setAgentLaunchTag(agentId, launchTagToken);
    let launchedInstructions: string | undefined;
    const runtime = await ports.agentProcessManager.start(
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
          COFORGE_AGENT_PROXY_URL: ports.agentProxy?.url ?? "",
          ...agentRuntimeContextEnvironment({
            agentId,
            agentWorkspaceDirectory: workspaceDirectory,
            identity: launchConfig.identity,
          }),
          COFORGE_AGENT_LAUNCH_TAG: agentLaunchTag(agentId, launchTagToken),
          COFORGE_AGENT_LAUNCH_ID: launch.launchId,
        },
        runtimeId: launch.launchId,
        onSessionId: sessionIds.onSessionId,
        sessionMode: recycled ? "create" : reference.sessionMode,
        assignedSkillPacks: parseAssignedSkillPacks(launchConfig.assignedSkillPacks),
        identity: launchConfig.identity,
        onInstructions: (instructions) => {
          launchedInstructions = instructions;
        },
        serverLaunch: managedScope
          ? {
              requestId: managedScope.requestId,
              controlEpoch: managedScope.controlEpoch ?? 0,
              launchId: managedScope.launchId,
            }
          : undefined,
      },
    );
    timing.phase("provider_session");
    if (launchedInstructions !== undefined) {
      const reportedSessionId = sessionIds.reportedSessionId();
      ports.contexts.recordStandingPrompt(agentId, {
        instructions: launchedInstructions,
        provider: config.provider,
        sessionId: reportedSessionId ?? requestedSessionId,
        resumed:
          resumedSessionId !== undefined &&
          sessionIds.driverReplacedSessionId() === undefined &&
          (reportedSessionId === undefined || reportedSessionId === resumedSessionId),
      });
    }
    if (claimAgentLaunchTagSweep(agentId)) sweepAgentLaunchTagStrays(agentId, "launch");
    await openLaunchSessionMemory({
      agentId,
      launchId: launch.launchId,
      recycled: recycled !== undefined,
      ...(recycled ? { recycledMemoryBlock: recycled.carriedMemoryBlock } : {}),
      sessionMode: reference.sessionMode,
      requestedSessionId,
      reportedSessionId: sessionIds.reportedSessionId(),
      providerReplaced: sessionIds.driverReplacedSessionId() !== undefined,
      attach: () => ports.attachSessionMemory(agentId),
    });
    if (parseAssignedSkillPacks(launchConfig.assignedSkillPacks).includes("weekly-report-collect"))
      ports.collectSkillAgents.add(agentId);
    if (ports.stops.stopping(agentId)) {
      await ports.agentProcessManager.stop(agentId);
      throw new Error(`Agent runtime is stopping: ${agentId}`);
    }
    ports.sendAgentStatus(agentId, "active");
    ports.activityPublisher.publish(agentId, launch, {
      ...ports.drafts.starting(agentId),
      requestId,
    });
    launch.startup = agentStartup(config.provider, () =>
      ports.scheduleStartupFailure(agentId, launch),
    );
    const { trajectory, progress, toolCalls, replyIntents } = trackAgentLaunch(
      ports,
      agentId,
      launch,
      config,
      runtime,
      control,
    );
    const replayWatch = new ProviderReplayWatch(resumedSessionId, {
      replacedSessionId: sessionIds.driverReplacedSessionId(),
      reportedSessionId: sessionIds.reportedSessionId(),
    });
    const unsubscribe = runtime.session.subscribe((event) => {
      progress.observe(event);
      toolCalls.observe(event);
      replyIntents.observe(event);
      earlyCrashWatch.observe(event);
      const isCurrent = current();
      if (isCurrent && isMainSessionModelOutput(event)) ports.exitStreak.clear(agentId);
      const recoverySignal = isCurrent ? runtimeErrorRecoverySignal(event) : undefined;
      if (isCurrent && (event.type === "text-delta" || event.type === "tool-start")) {
        ports.runtimeErrorHold.resetZeroEvidence(agentId);
      }
      if (recoverySignal)
        ports.runtimeErrorHold.noteRecoverySignal(
          agentId,
          recoverySignal,
          launch.runtimeErrorClassFence,
          progress.turnStartedAtMs,
        );
      if (isCurrent) launch.startup?.observe(event);
      const turnActivity =
        event.type === "activity"
          ? isBusyActivityDetailKind(event.activity.detailKind)
          : TURN_ACTIVITY_EVENT_TYPES.has(event.type);
      if (turnActivity && ports.reconcileIdleTurn(agentId, launch)) return;
      trajectory.accept(event);
      if (isCurrent)
        replayWatch.observe(event, agentId, (stored) =>
          ports.coldStartRejectedReplay(agentId, launch, stored, request),
        );
    });
    runtime.session.onExit((exit) => {
      launch.startup?.dispose();
      trajectory.dispose();
      toolCalls.logAbandoned();
      replyIntents.dispose();
      if (ports.currentActivityLaunches.get(agentId) !== launch) return;
      ports.desktops.end(agentId);
      ports.disposeLaunchObservations(agentId);
      ports.collectSkillAgents.delete(agentId);
      ports.introducedAgents.delete(agentId);
      ports.messageAttention.clearAgent(agentId);
      ports.deliveryGate.onProcessExit(agentId);
      ports.lifecycle.processClosed(agentId);
      void ports.revokeAgentApiKey(agentId, agentApiKey).catch((revokeError) => {
        logAgentApiKeyRevokeFailed(agentId, revokeError);
      });
      unsubscribe();
      clearAgentLaunchTag(agentId, launchTagToken);
      if (launch.stopping) return;
      if (!launch.crashDetail) {
        ports.systemCleaner.onAgentWorkingToIdle(agentId);
        ports.idleNudge?.maybeAsk(agentId);
      }
      if (control || reused)
        void runtime.session
          .readSessionIdentity?.()
          .then((identity) => ports.agentControl.stopped(agentId, launch.launchId, identity))
          .then(() => ports.agentSessions.replay(agentId))
          .catch(() => {});
      if (
        !ports.isStopping() &&
        !launch.offlineError &&
        isUncleanExit({ crash: launch.crashDetail, exit })
      ) {
        const attempts = ports.exitStreak.note(agentId);
        if (attempts >= EXIT_STREAK_CAP) {
          ports.exitStreak.clear(agentId);
          ports.offlineResidency.takeOfflineAfterExit(
            agentId,
            launch,
            config.provider,
            buildExitStreakActivity(attempts),
            {
              event: "agent_runtime:exit_streak",
              errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
              errorReason: "runtime_error_fenced",
            },
          );
        }
      }
      const crashed = launch.offlineError
        ? ports.activity(
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
      ports.activityPublisher.publish(
        agentId,
        launch,
        crashed
          ? ports.activity(agentId, crashed.detailKind, crashed.level, crashed.detail, {
              entries: crashed.entries,
              runtimeError: crashed.runtimeError,
            })
          : ports.drafts.stopped(agentId),
      );
      if (ports.currentActivityLaunches.get(agentId) === launch)
        ports.currentActivityLaunches.delete(agentId);
      earlyCrashWatch.close({
        agentId,
        resumedSessionId,
        staleSessionId: reference.sessionId ?? requestedSessionId,
        offline: launch.offlineError !== undefined,
        deliveryHold: ports.deliveryGate.explicitHold(agentId) !== undefined,
        daemonStopping: ports.isStopping(),
        exit,
        streak: ports.resumedEarlyCrash,
        coldStart: (id, stale) => ports.coldStartResumedSession(id, launch, stale),
      });
      if (
        (launch.crashDetail !== undefined || launch.offlineError !== undefined) &&
        !ports.isStopping() &&
        !agentRelaunchPending(agentId) &&
        !ports.agentControl.startPending(agentId) &&
        !ports.offlineResidency.hasLaunchWait(agentId)
      )
        sweepAgentLaunchTagStrays(agentId, "exit");
    });
    if (reused)
      wakeReusedAgent(runtime.session, (identity) =>
        ports.agentControl.wake(agentId, launch.launchId, identity),
      );
    void ports.appInbox.drainAppInboxNotices(agentId).catch(() => {});
    return runtime;
  } catch (error) {
    ports.desktops.end(agentId);
    launch.startup?.dispose();
    if (launchTagToken) clearAgentLaunchTag(agentId, launchTagToken);
    if (issuedProxyToken) {
      restoreSupersededProxyToken(ports.agentProxyTokens, agentId, proxyToken, priorProxyToken);
      if (localContext !== undefined) ports.revokeLocalLaunch(agentId, localContext, proxyToken);
    }
    if (agentApiKey) {
      restoreSupersededAgentApiKey(ports.agentApiKeys, agentId, agentApiKey, priorAgentApiKey);
      try {
        await ports.revokeAgentApiKey(agentId, agentApiKey);
      } catch (revokeError) {
        logAgentApiKeyRevokeFailed(agentId, revokeError);
      }
    }
    reportLaunchFailure(ports, agentId, launch, config, error, { managed: control !== undefined });
    if (ports.currentActivityLaunches.get(agentId) === launch) {
      ports.activityPublisher.forgetBusy(agentId);
      ports.disposeLaunchObservations(agentId);
      if (!ports.stops.pendingStop(agentId)) ports.currentActivityLaunches.delete(agentId);
    }
    throw error;
  }
}
