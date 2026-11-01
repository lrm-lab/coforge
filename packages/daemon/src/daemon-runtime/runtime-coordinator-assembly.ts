import { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import { AgentMigrationBucketClient } from "#src/connection/agent-migration-bucket-client";
import { AgentRuntimeState } from "#src/agent-runtime/agent-runtime-state";
import { MemoryAgentRuntimeStateStore } from "#src/persistence/memory-agent-runtime-state-store";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import { AgentMessageOperations } from "./agent-message-operations";
import { AgentRequestForwarder } from "./agent-request-forwarder";
import { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import { FileReminderReceiptStore } from "#src/persistence/reminder-receipt-store";
import { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import { AgentLaunchCustody } from "./agent-launch-custody";
import { AgentStopCoordinator } from "./agent-stop-coordinator";
import { AgentLaunchCoordinator } from "./agent-launch-coordinator";
import { AGENT_ACTIVITY_DETAIL_KIND, CLEANER_APP_ID } from "@lrm/coforge-sdk/internal";
import { connectionSessionInvalidate } from "./session-invalidate-activity";
import { runtimeConfigOf, recoveryOf } from "./runtime-launch-intent";
import { rememberUsage } from "./usage-memory";
import { agentsDirectory, agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";

/** Inputs captured from DaemonRuntime while assembling its collaborating coordinators. */
export type RuntimeCoordinatorAssemblyPorts = Record<string, any>;

export type RuntimeCoordinatorAssembly = Record<string, any>;

export function createRuntimeCoordinatorAssembly(
  ports: RuntimeCoordinatorAssemblyPorts,
): RuntimeCoordinatorAssembly {
  const { connection, stateDirectory } = ports;
  const result = {} as RuntimeCoordinatorAssembly;
  result.inboxCoordinator = new AgentInboxCoordinator({
    workspaceId: connection.workspaceId,
    stateDirectory,
    consumedSeqs: ports.consumedSeqs,
    messageAttention: ports.messageAttention,
    deliveryQueue: ports.deliveryQueue,
    runtimeRelease: ports.runtimeRelease,
    processManager: ports.agentProcessManager,
    startAgent: (agentId: any, config: any, sessionId: any) =>
      ports.startAgent(agentId, config, undefined, { sessionId }),
    currentActivityLaunch: (agentId: any) => ports.currentActivityLaunches.get(agentId),
    reconcileIdleTurn: (agentId: any, launch: any) => ports.reconcileIdleTurn(agentId, launch),
    mentionDeliveries: ports.mentionDeliveries,
    assertRunning: () => ports.assertRunning(),
    agentIdForContext: (context: any) => ports.agentIdForContext(context),
  });
  result.agentRequests = new AgentRequestForwarder({
    get transport() {
      return ports.transport();
    },
    connection,
    authorizedAgent: (context: any, agentApiKey: any) =>
      ports.authorizedAgent(context, agentApiKey),
  });
  result.messageOperations = new AgentMessageOperations({
    connection,
    attention: ports.messageAttention,
    isMemoryAgent: (agentId: any) => Boolean(ports.memoryFence(agentId)),
    contexts: ports.contexts,
    inbox: (agentId: any) => result.inboxCoordinator.agentInbox(agentId),
    appItemsPending: (agentId: any) => result.inboxCoordinator.appItemsPending(agentId),
    get transport() {
      return ports.transport();
    },
    reportFreshnessHold: (agentId: any, activity: any) =>
      ports.activityPublisher.publishCurrent(
        agentId,
        ports.activity(
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
  result.reminders = new ReminderScheduler(
    { workspaceId: connection.workspaceId, computerId: connection.computerId },
    new FileReminderReceiptStore(stateDirectory, connection.workspaceId, connection.computerId),
    (request: any) => {
      if (!ports.transport().fireReminder) throw new Error("reminder fire is unavailable");
      return ports.transport().fireReminder(request);
    },
    (job: any, occurrence: any) => ports.acceptReminderDue(job, occurrence.late),
  );
  result.systemCleaner = new SystemCleaner({
    ...ports.systemCleanerOptions,
    agentsDirectory: agentsDirectory(connection.workspaceRoot, connection.workspaceId),
    inbox: {
      upsert: async (agentId: any, item: any) =>
        (await result.inboxCoordinator.appInbox(agentId)).upsert(item),
      remove: (agentId: any, itemId: any) => result.inboxCoordinator.removeAppItem(agentId, itemId),
    },
    wake: async (agentId: any, itemId: any) => {
      // A busy Agent sees the item at its next idle drain; a stopped one at its next launch.
      if (ports.isWorking(agentId)) return;
      await result.inboxCoordinator.notifyAppItem(agentId, itemId, { startStopped: false });
    },
  });
  result.appConfigs = new AgentAppConfigSync({
    // `#requestAppConfigSnapshot` asks only through a transport that has the method.
    requestSnapshot: (agentId: any) =>
      ports.transport().requestAppConfigSnapshot!({
        ...ports.envelope(),
        agentId,
      }),
    apps: { [CLEANER_APP_ID]: result.systemCleaner },
  });
  // The transport is replaced on each start, so the runner reaches the route through whichever
  // one is current.
  result.migrations = ports.transport().agentMigrationServer
    ? new AgentMigrationRunner({
        server: () => ports.transport().agentMigrationServer!(),
        bucket: new AgentMigrationBucketClient(),
        agents: {
          stop: (agentId: any) => ports.stopAgent(agentId),
          isRunning: (agentId: any) =>
            ports.agentProcessManager.runningAgentIds().includes(agentId),
          movedAway: (agentId: any) => ports.forgetLocalAgent(agentId),
        },
        workspaceDirectory: (agentId: any) =>
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
  result.agentSessions = new AgentSessions(state, async (snapshot: any) => {
    await ports.reportAgentSession({
      protocolMajor: snapshot.protocolMajor,
      requestId: crypto.randomUUID(),
      workspaceId: snapshot.workspaceId,
      computerId: snapshot.computerId,
      agentId: snapshot.agentId,
      provider: snapshot.provider,
      startRequestId: snapshot.requestId,
      daemonInstanceId: snapshot.daemonInstanceId ?? ports.runtimeInstanceId,
      launchId: snapshot.launchId,
      sessionId: snapshot.identity.sessionId,
      sessionState: snapshot.identity.state,
      controlEpoch: snapshot.epoch,
      sequence: snapshot.sequence,
    });
  });
  result.agentControl = new AgentControl(ports.runtimeInstanceId, state, result.agentSessions, {
    running: (agentId: any) => Boolean(ports.agentProcessManager.session(agentId)),
    stop: async (agentId: any) => {
      const session = ports.agentProcessManager.session(agentId);
      await ports.stopAgent(agentId);
      return session?.readSessionIdentity?.();
    },
    launch: async (intent: any, launchId: any, replacedSessionId: any, invalidateReason: any) => {
      if (replacedSessionId) ports.sessionReferences.delete(intent.agentId);
      const runtime = await ports.startAgent(
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
    wake: async (intent: any) => {
      await ports.startAgent(
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
    rebind: (intent: any, launchId: any) => ports.rebindAgent(intent, launchId),
    startSettled: (agentId: any) => ports.exitedDelivery.releaseStartBuffer(agentId),
    // `launchId` is always present here (minted synchronously by `AgentControl.start()`
    // before this call); the wire message and the retry's cold-start Activity
    // (`#launchAgent`'s `request.invalidateReason` narration) both follow that same,
    // effectively-unconditional signal — there is no longer a separate controlEpoch gate.
    invalidateSession: (intent: any, launchId: any, sessionId: any, reason: any) => {
      ports.transport().sendSessionInvalidate?.(
        connectionSessionInvalidate(ports.connection, ports.runtimeInstanceId, {
          agentId: intent.agentId,
          provider: intent.provider,
          sessionId,
          launchId,
          reason,
        }),
      );
    },
    result: async (result: any) => {
      await ports.transport().sendAgentControlResult?.(result);
    },
  });
  result.observationPorts = {
    activityPublisher: ports.activityPublisher,
    deliveryQueue: ports.deliveryQueue,
    offlineResidency: ports.offlineResidency,
    usageReport: ports.usageReport,
    phaseBookkeeping: ports.phaseBookkeeping,
    runtimeErrorHold: ports.runtimeErrorHold,
    mentionDeliveries: ports.mentionDeliveries,
    agentSessions: result.agentSessions,
    systemCleaner: result.systemCleaner,
    collectSkillAgents: ports.collectSkillAgents,
    fastModeWarned: ports.fastModeWarned,
    isWorking: (agentId: any) => ports.isWorking(agentId),
    activityDraft: (agentId: any, kind: any, level: any, detail: any, extra: any) =>
      ports.activity(agentId, kind, level, detail, extra),
    runtimeErrorActivity: (agentId: any, message: any) =>
      ports.drafts.runtimeError(agentId, message),
    interruptedActivity: (agentId: any) => ports.drafts.interrupted(agentId),
    showQuietTurn: (agentId: any, launch: any, publish: any) =>
      ports.showQuietTurn(agentId, launch, publish),
    reconcileIdleTurn: (agentId: any, launch: any) => ports.reconcileIdleTurn(agentId, launch),
    rememberUsage: (snapshot: any) => rememberUsage(ports.observedUsage, snapshot),
    releaseTurnEndHolds: (agentId: any) => ports.releaseTurnEndHolds(agentId),
    drainAppInboxNotices: (agentId: any) => result.inboxCoordinator.drainAppInboxNotices(agentId),
    failCollectorRunningSlots: (agentId: any, reason: any) =>
      ports.failCollectorRunningSlots(agentId, reason),
  };
  result.launchCustody = new AgentLaunchCustody({
    messageAttention: ports.messageAttention,
    deliveryQueue: ports.deliveryQueue,
    inputDrain: ports.inputDrain,
    agentProcessManager: ports.agentProcessManager,
    currentActivityLaunches: ports.currentActivityLaunches,
    introducedAgents: ports.introducedAgents,
    releaseHeldAppItems: (agentId: any) => result.inboxCoordinator.releaseHeldAppItems(agentId),
    releaseFallbackNotices: (agentId: any) =>
      result.inboxCoordinator.releaseFallbackNotices(agentId),
  });
  result.stopCoordinator = new AgentStopCoordinator({
    agentLaunches: ports.agentLaunches,
    currentActivityLaunches: ports.currentActivityLaunches,
    inputDrain: ports.inputDrain,
    processManager: ports.agentProcessManager,
    activityPublisher: ports.activityPublisher,
    desktops: ports.desktops,
    agentApiKeys: ports.agentApiKeys,
    revokeAgentApiKey: (agentId: any, apiKey: any) => ports.revokeAgentApiKey(agentId, apiKey),
    messageAttention: ports.messageAttention,
    deliveryQueue: ports.deliveryQueue,
    runtimeErrorHold: ports.runtimeErrorHold,
    offlineResidency: ports.offlineResidency,
    sendAgentStatus: (agentId: any, status: any) => ports.sendAgentStatus(agentId, status),
    publishStopped: (agentId: any, launch: any) =>
      ports.activityPublisher.publish(agentId, launch, ports.drafts.stopped(agentId)),
  });
  result.launchCoordinator = new AgentLaunchCoordinator({
    connection: ports.connection,
    transport: () => ports.transport(),
    runtimeInstanceId: ports.runtimeInstanceId,
    agentProcessManager: ports.agentProcessManager,
    sessionReferences: ports.sessionReferences,
    currentActivityLaunches: ports.currentActivityLaunches,
    activityPublisher: ports.activityPublisher,
    phaseBookkeeping: ports.phaseBookkeeping,
    contexts: ports.contexts,
    deliveryQueue: ports.deliveryQueue,
    usageReport: ports.usageReport,
    fastModeWarned: ports.fastModeWarned,
    sync: ports.sync,
    agentApiKeys: ports.agentApiKeys,
    agentProxy: ports.agentProxy,
    agentProxyTokens: ports.agentProxyTokens,
    desktops: ports.desktops,
    wakeRecycle: ports.wakeRecycle,
    stoppingAgents: ports.stoppingAgents,
    collectSkillAgents: ports.collectSkillAgents,
    introducedAgents: ports.introducedAgents,
    messageAttention: ports.messageAttention,
    agentControl: result.agentControl,
    agentSessions: result.agentSessions,
    runtimeErrorHold: ports.runtimeErrorHold,
    replyIntents: ports.replyIntents,
    offlineResidency: ports.offlineResidency,
    drafts: ports.drafts,
    systemCleaner: result.systemCleaner,
    agentStops: ports.agentStops,
    isStopping: () => ports.stopping,
    assertRunning: () => ports.assertRunning(),
    assertAgentNotStopping: (agentId: any) => ports.assertAgentNotStopping(agentId),
    contextFor: (agentId: any) => ports.contextFor(agentId),
    envelope: () => ports.envelope(),
    reportAgentSession: (report: any) => ports.reportAgentSession(report),
    sendAgentStatus: (agentId: any, status: any) => ports.sendAgentStatus(agentId, status),
    scheduleStartupFailure: (agentId: any, launch: any) =>
      ports.scheduleStartupFailure(agentId, launch),
    observeRuntimeEvent: (
      agentId: any,
      launch: any,
      config: any,
      runtime: any,
      managed: any,
      event: any,
    ) => ports.observeRuntimeEvent(agentId, launch, config, runtime, managed, event),
    reconcileIdleTurn: (agentId: any, launch: any) => ports.reconcileIdleTurn(agentId, launch),
    activity: (agentId: any, detailKind: any, level: any, detail: any, extra: any) =>
      ports.activity(agentId, detailKind, level, detail, extra),
    narrateUnavailable: (agentId: any, launch: any, activity: any) =>
      ports.narrateUnavailable(agentId, launch, activity),
    disposeLaunchObservations: (agentId: any) => ports.disposeLaunchObservations(agentId),
    revokeLocalLaunch: (agentId: any, context: any, proxyToken: any) =>
      ports.revokeLocalLaunch(agentId, context, proxyToken),
    revokeAgentApiKey: (agentId: any, apiKey: any) => ports.revokeAgentApiKey(agentId, apiKey),
    launchFailureActivity: (agentId: any, provider: any, error: any) =>
      ports.launchFailureActivity(agentId, provider, error),
    drainAppInboxNotices: (agentId: any) => result.inboxCoordinator.drainAppInboxNotices(agentId),
  });

  return result;
}
