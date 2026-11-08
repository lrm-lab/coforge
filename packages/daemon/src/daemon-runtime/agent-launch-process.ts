import { isMemoryAgentRuntime } from "@coforge/agent";
import { AgentAuthorizationError } from "#src/agent-runtime/launch-failure";
import { AgentStartup } from "#src/agent-runtime/agent-startup";
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
import { ResumedEarlyCrashWatch, type ResumedEarlyCrashStreak } from "./resumed-early-crash";
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
    /** Consecutive qualifying early crashes of a resumed Session, across launches. */
    resumedEarlyCrash: ResumedEarlyCrashStreak;
    /** The streak hit its threshold: invalidate the stale Session and cold-start fresh. */
    coldStartResumedSession(agentId: string, launch: ActivityLaunch, staleSessionId: string): void;
  },
  agentId: string,
  config: AgentRuntimeConfig,
  request: LaunchRequest,
  launch: ActivityLaunch,
  reference: SessionReference,
  requestId: string,
  previousLaunchId: string | undefined,
  reused: boolean,
  managedScope: { controlEpoch?: number; requestId: string; launchId: string } | undefined,
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
  // The key and proxy token this launch displaces from the tables: a still-running process
  // holds them, and a failed launch puts them back so that process loses neither its
  // credential nor its local proxy binding mid-flight.
  let priorAgentApiKey: string | undefined;
  let priorProxyToken: string | undefined;
  // Minted inside the try; empty until then so the catch can drop a failed launch's token.
  let launchTagToken = "";
  let proxyToken: string | undefined;
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
    // Skipped at spawn, never deleted: report each reserved stored variable by name.
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
    localContext = proxyToken ?? ports.contextFor(agentId);
    const desktopEnvironment = await ports.desktops.hold(agentId);
    const workspaceDirectory = agentWorkspaceDirectory(
      ports.connection.workspaceRoot,
      ports.connection.workspaceId,
      agentId,
    );
    // A session left cold with a large context is not resumed: a fresh one opens with a briefing.
    const recycled = request.replacedSessionId
      ? undefined
      : await ports.wakeRecycle.plan({
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
    if (recycled) ports.narrateUnavailable(agentId, launch, { detail: recycled.activityText });
    // The session this launch asked to continue, kept before any report can overwrite the
    // reference: whether the provider actually continued it decides "fresh" below.
    const requestedSessionId = recycled ? undefined : reference.sessionId;
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
    // The resumed-session early-crash clock (resumed-early-crash.ts): from the provider session
    // request, and whether the provider produced model output before the process ended.
    const earlyCrashWatch = new ResumedEarlyCrashWatch();
    // The adapter's own spawn + ACP initialize complete with this call; one phase covers both.
    // The launch tag is minted per process launch, never the reused launch identity: a wake
    // reusing `launchId` must still produce a token no earlier stray can share (task #673).
    launchTagToken = crypto.randomUUID();
    // Registered before the spawn so a concurrent sweep's spare check already protects the
    // new runtime's processes; a failed start leaves a token no live process carries.
    setAgentLaunchTag(agentId, launchTagToken);
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
          // Same server-authored identity the standing prompt's "Current Runtime Context"
          // section renders; exported so the Agent process and every tool it spawns
          // can read these facts directly instead of parsing them out of prose.
          ...agentRuntimeContextEnvironment({
            agentId,
            agentWorkspaceDirectory: workspaceDirectory,
            identity: launchConfig.identity,
          }),
          COFORGE_AGENT_LAUNCH_TAG: agentLaunchTag(agentId, launchTagToken),
          // This launch's own identity, so a provider process and the records it writes can be
          // attributed to the launch that spawned them (task #698).
          COFORGE_AGENT_LAUNCH_ID: launch.launchId,
        },
        runtimeId: launch.launchId,
        onSessionId: sessionIds.onSessionId,
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
    timing.phase("provider_session");
    // Strays from before this Daemon started are collected once, on the Agent's first launch.
    if (claimAgentLaunchTagSweep(agentId)) sweepAgentLaunchTagStrays(agentId, "launch");
    await openLaunchSessionMemory({
      agentId,
      launchId: launch.launchId,
      recycled: recycled !== undefined,
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
    launch.startup = new AgentStartup(() => ports.scheduleStartupFailure(agentId, launch));
    const { trajectory, progress, toolCalls, replyIntents } = trackAgentLaunch(
      ports,
      agentId,
      launch,
      config,
      runtime,
      control,
    );
    const unsubscribe = runtime.session.subscribe((event) => {
      progress.observe(event);
      toolCalls.observe(event);
      replyIntents.observe(event);
      earlyCrashWatch.observe(event);
      const isCurrent = current();
      // Raw: text and thinking count before the trajectory coalesces them, and before this
      // event marks the Agent busy (a hold released while busy flushes only at the turn end).
      const recoverySignal = isCurrent ? runtimeErrorRecoverySignal(event) : undefined;
      if (recoverySignal)
        ports.runtimeErrorHold.noteRecoverySignal(
          agentId,
          recoverySignal,
          launch.runtimeErrorClassFence,
        );
      if (isCurrent) launch.startup?.observe(event);
      const turnActivity =
        event.type === "activity"
          ? isBusyActivityDetailKind(event.activity.detailKind)
          : TURN_ACTIVITY_EVENT_TYPES.has(event.type);
      if (turnActivity && ports.reconcileIdleTurn(agentId, launch)) return;
      trajectory.accept(event);
    });
    runtime.session.onExit((exit) => {
      ports.desktops.end(agentId);
      launch.startup?.dispose();
      trajectory.dispose();
      replyIntents.dispose();
      if (ports.currentActivityLaunches.get(agentId) !== launch) return;
      // No leaked watchdog timer, and a later launch for this Agent starts clean.
      ports.disposeLaunchObservations(agentId);
      ports.collectSkillAgents.delete(agentId);
      ports.introducedAgents.delete(agentId);
      ports.messageAttention.clearAgent(agentId);
      // An unexpected exit only clears busy — whatever a queue_until_idle provider
      // was still holding stays queued for the next launch; only explicit Stop discards it
      // (see AgentStopCoordinator.releaseAgentRuntime).
      ports.deliveryQueue.onProcessExit(agentId);
      ports.revokeLocalLaunch(agentId, localContext, proxyToken);
      void ports.revokeAgentApiKey(agentId, agentApiKey).catch((revokeError) => {
        // Local access is already revoked; the key stays pending and is retried later.
        logAgentApiKeyRevokeFailed(agentId, revokeError);
      });
      unsubscribe();
      // The exited launch's token leaves the registry so its strays are never spared as
      // "current"; the guarded clear leaves a newer launch's token alone (task #673).
      clearAgentLaunchTag(agentId, launchTagToken);
      if (launch.stopping) return;
      // A process that ended without a crash has stopped working too.
      if (!launch.crashDetail) {
        ports.systemCleaner.onAgentWorkingToIdle(agentId);
        ports.idleNudge?.maybeAsk(agentId);
      }
      // A reused launch is tracked by AgentControl exactly like a managed one is —
      // its exit must flip the on-disk record back to "stopped" (via `wake()`'s mirror image,
      // `stopped()`) so a later wake or server Start sees a truthful record.
      if (control || reused)
        void runtime.session
          .readSessionIdentity?.()
          .then((identity) => ports.agentControl.stopped(agentId, launch.launchId, identity))
          .then(() => ports.agentSessions.replay(agentId))
          .catch(() => {});
      // An exit that leaves the most recent `error` event unresolved by a `completed`
      // outcome is a crash; any other unintentional exit keeps the stopped wording, because
      // the Agent's control state is stopped either way.
      // An exit after an offline error republishes that error's Activity (the same wording,
      // as the reference Computer does at close) rather than a bare `runtime_crashed`.
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
      // A stored Session that keeps killing the runtime seconds after every resume is corrupt:
      // count qualifying closes and, at the threshold, invalidate it and cold-start fresh
      // (resumed-early-crash.ts; Raft 1.0.63 `noteResumedEarlyCrashClose` + `repeated_early_crash`).
      earlyCrashWatch.close({
        agentId,
        resumedSessionId: requestedSessionId,
        staleSessionId: reference.sessionId ?? requestedSessionId,
        sessionModeCreate: reference.sessionMode === "create",
        offline: launch.offlineError !== undefined,
        deliveryHold: ports.deliveryQueue.explicitHold(agentId) !== undefined,
        daemonStopping: ports.isStopping(),
        exit,
        streak: ports.resumedEarlyCrash,
        coldStart: (id, stale) => ports.coldStartResumedSession(id, launch, stale),
      });
      // Collect strays only when a crash leaves the Agent stopped for good: an automatic
      // relaunch, a pending managed Start or a quota wait means it continues under a new
      // token and keeps its background processes (#673).
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
    void ports.drainAppInboxNotices(agentId).catch(() => {});
    return runtime;
  } catch (error) {
    ports.desktops.end(agentId);
    launch.startup?.dispose();
    // A failed launch's token must not stay registered: its partial spawn's strays would
    // otherwise be spared as "current" by every later sweep (task #673).
    if (launchTagToken) clearAgentLaunchTag(agentId, launchTagToken);
    restoreSupersededProxyToken(ports.agentProxyTokens, agentId, proxyToken, priorProxyToken);
    // Only what this launch issued is revoked: a launch that failed before the issue touches
    // no table entry, and the running process's own pair is never read as this launch's.
    if (localContext !== undefined) ports.revokeLocalLaunch(agentId, localContext, proxyToken);
    if (agentApiKey) {
      restoreSupersededAgentApiKey(ports.agentApiKeys, agentId, agentApiKey, priorAgentApiKey);
      try {
        await ports.revokeAgentApiKey(agentId, agentApiKey);
      } catch (revokeError) {
        logAgentApiKeyRevokeFailed(agentId, revokeError);
      }
    }
    reportLaunchFailure(ports, agentId, launch, config, error);
    if (ports.currentActivityLaunches.get(agentId) === launch) {
      ports.activityPublisher.forgetBusy(agentId);
      ports.disposeLaunchObservations(agentId);
      // An explicit Stop still needs this identity to report its final outcome.
      if (!ports.stops.pendingStop(agentId)) ports.currentActivityLaunches.delete(agentId);
    }
    throw error;
  }
}
