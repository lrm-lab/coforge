import { isMemoryAgentRuntime } from "@coforge/agent";
import { AgentAuthorizationError, launchFailureLogFields } from "#src/agent-runtime/launch-failure";
import { AgentStartup } from "#src/agent-runtime/agent-startup";
import { ActivityTrajectory } from "#src/agent-runtime/activity-trajectory";
import { agentRuntimeContextEnvironment } from "#src/code-agent/environment";
import { parseAssignedSkillPacks } from "#src/code-agent/assigned-skills";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { ProviderProgress } from "./stalled-recovery";
import { LaunchPhaseTiming } from "./launch-phase-timing";
import {
  StalledTurnTracker,
  stalledTurnNotice,
  stalledTurnSilenceMs,
} from "./stalled-turn-indicator";
import { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import { OutstandingBackgroundTasks } from "#src/agent-runtime/subagent-progress-activity";
import { buildRuntimeCrashedActivity } from "#src/agent-runtime/runtime-error-activity";
import { TURN_ACTIVITY_EVENT_TYPES } from "#src/agent-runtime/runtime-phases";
import { runtimeErrorRecoverySignal } from "#src/agent-runtime/runtime-error-recovery";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { isBusyActivityDetailKind } from "./agent-activity-publisher";
import {
  connectionSessionInvalidate,
  runtimeDisplayName,
  sessionInvalidateActivityText,
} from "./session-invalidate-activity";
import { ignoredAgentEnvironmentActivity } from "./agent-environment-activity";
import { requestAgentLaunchConfig } from "./agent-launch-config";
import { wakeReusedAgent } from "./agent-wake-control";
import { logAgentApiKeyRevokeFailed } from "./agent-failure-logs";
import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeConfig, AgentRuntimeEvent } from "@lrm/coforge-anvil";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { ActivityLaunch } from "./activity-launch";
import type { LaunchRequest } from "./runtime-launch-types";
import type { SessionReference } from "./launch-identity";
import type { AgentLaunchCoordinatorPorts } from "./agent-launch-coordinator";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export async function launchAgentProcess(
  ports: AgentLaunchCoordinatorPorts,
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
    ports.assertRunning();
    ports.assertAgentNotStopping(agentId);
    // Skipped at spawn, never deleted: report each reserved stored variable by name.
    const skipped = ignoredAgentEnvironmentActivity(
      { workspaceId: ports.connection.workspaceId, agentId },
      launchConfig.envVars,
      config.provider,
    );
    if (skipped) ports.activityPublisher.publish(agentId, launch, skipped);
    ports.agentApiKeys.set(agentId, agentApiKey);
    const proxyToken = ports.agentProxy?.issue(agentId, agentApiKey);
    if (proxyToken) ports.agentProxyTokens.set(agentId, proxyToken);
    const localContext = proxyToken ?? ports.contextFor(agentId);
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
    // The adapter's own spawn + ACP initialize complete with this call; one phase covers both.
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
        },
        runtimeId: launch.launchId,
        onSessionId: ports.transport().reportAgentSession
          ? async (reportedSessionId, driverReplacedSessionId) => {
              if (!current() || ports.isStopping())
                throw new Error("Agent session launch was superseded");
              // Kept for compat on the session report's own `replacedSessionId` field only
              // (unrelated to whether an invalidate is sent below): either a driver-reported
              // replacement just now, or one carried over from AgentControl's own retry.
              const replaced =
                driverReplacedSessionId ?? recycledSessionId ?? request.replacedSessionId;
              if (driverReplacedSessionId) {
                // Claude Code/Codex replace a missing native session inside the driver: only a
                // driver-reported replacement (not AgentControl's carried-over
                // `request.replacedSessionId`, already reported once) emits here. Sent BEFORE
                // the session report below, fire-and-forget, so the server can still match the
                // stale session; after the report lands this would be a no-op.
                ports.transport().sendSessionInvalidate?.(
                  connectionSessionInvalidate(ports.connection, ports.runtimeInstanceId, {
                    agentId,
                    provider: config.provider,
                    sessionId: driverReplacedSessionId,
                    launchId: launch.launchId,
                    reason: "missing",
                  }),
                );
              }
              await ports.reportAgentSession({
                ...ports.envelope(),
                agentId,
                provider: config.provider,
                sessionId: reportedSessionId,
                ...(replaced ? { replacedSessionId: replaced } : {}),
                daemonInstanceId: ports.runtimeInstanceId,
                launchId: launch.launchId,
                // Read live off `reference` (the same object `#rebindAgent` mutates in place),
                // not the `requestId`/`control` consts this closure captured at
                // launch time: a driver-side session replacement reported after a rebind must
                // carry the NEW request/epoch, not the one this launch started under.
                startRequestId: reference.requestId,
                ...(reference.controlEpoch ? { controlEpoch: reference.controlEpoch } : {}),
                ...(previousLaunchId ? { previousLaunchId } : {}),
              });
              timing.phase("session_reported");
              if (!current()) return;
              reference.sessionId = reportedSessionId;
              reference.sessionMode = "resume";
              reference.launchId = launch.launchId;
              if (driverReplacedSessionId)
                ports.narrateUnavailable(
                  agentId,
                  launch,
                  sessionInvalidateActivityText(
                    runtimeDisplayName(config.provider),
                    driverReplacedSessionId,
                    "missing",
                  ),
                );
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
    timing.phase("provider_session");
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
    const trajectories = new Map<string, ActivityTrajectory>();
    const trajectoryFor = (scope: AgentRuntimeEvent["conversation"]) => {
      const key = scope?.conversationId ?? "";
      let trajectory = trajectories.get(key);
      if (!trajectory) {
        trajectory = new ActivityTrajectory((event) =>
          ports.observeRuntimeEvent(agentId, launch, config, runtime, Boolean(control), {
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
        isCurrent: (id) => ports.currentActivityLaunches.get(id) === launch,
        publish: (id, detail) =>
          ports.activityPublisher.publish(
            id,
            launch,
            ports.activity(id, AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED, "error", detail),
          ),
      }),
      stalledTurnSilenceMs(config.envVars),
    );
    const replyIntents = ports.replyIntents.tracker(agentId, launch);
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
    runtime.session.onExit(() => {
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
      if (launch.stopping) return;
      // A process that ended without a crash has stopped working too.
      if (!launch.crashDetail) ports.systemCleaner.onAgentWorkingToIdle(agentId);
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
    ports.revokeLocalLaunch(agentId);
    if (agentApiKey) {
      try {
        await ports.revokeAgentApiKey(agentId, agentApiKey);
      } catch (revokeError) {
        logAgentApiKeyRevokeFailed(agentId, revokeError);
      }
    }
    if (!ports.isStopping() && !ports.stops.stopping(agentId)) {
      // The Activity sends people to the Computer log for the cause; this is that line.
      logger.warning("Agent launch failed", {
        event: "agent_runtime:launch_failed",
        agent_id: agentId,
        provider: config.provider,
        launch_id: launch.launchId,
        ...launchFailureLogFields(error),
        outcome: "failed",
      });
      ports.sendAgentStatus(agentId, "inactive");
      // A thrown launch failure whose text classifies as an offline error (auth, plan access)
      // gets that failure's prompt and offline record, not the generic launcher wording — as
      // the reference Computer does for `runtime.start.request_failed`. The launch-failure
      // reason in the log above stays the typed one; classification only chooses what the
      // person sees and what a later `no_process` rejection restates.
      const offlineLaunchError =
        launch.offlineError ??
        ports.offlineResidency.thrownLaunchActivity(
          agentId,
          launch,
          runtimeDisplayName(config.provider),
          config,
          error,
        );
      ports.activityPublisher.publish(
        agentId,
        launch,
        offlineLaunchError
          ? ports.activity(
              agentId,
              offlineLaunchError.detailKind,
              offlineLaunchError.level,
              offlineLaunchError.detail,
              {
                entries: offlineLaunchError.entries,
                runtimeError: offlineLaunchError.runtimeError,
              },
            )
          : ports.launchFailureActivity(agentId, config.provider, error),
      );
    }
    if (ports.currentActivityLaunches.get(agentId) === launch) {
      ports.activityPublisher.forgetBusy(agentId);
      ports.disposeLaunchObservations(agentId);
      // An explicit Stop still needs this identity to report its final outcome.
      if (!ports.stops.pendingStop(agentId)) ports.currentActivityLaunches.delete(agentId);
    }
    throw error;
  }
}
