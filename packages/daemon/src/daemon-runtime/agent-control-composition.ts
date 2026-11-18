import { MemoryAgentRuntimeStateStore } from "../persistence/memory-agent-runtime-state-store";
import type {
  AgentControlResult,
  AgentControlScope,
  AgentSessionReport,
  AgentStartIntent,
  RuntimeProvider,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { carriesStartInput } from "#src/agent-runtime/agent-control-replay";
import { AgentControlOpTiming } from "#src/agent-runtime/agent-control-timing";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentRuntimeState } from "#src/agent-runtime/agent-runtime-state";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { DaemonConfig } from "./runtime";
import type { AgentStopRegistry } from "./agent-stop-registry";
import { recoveryOf, runtimeConfigOf, type AgentRecoveryContext } from "./runtime-launch-intent";
import type { LaunchRequest } from "./runtime-launch-types";
import { connectionSessionInvalidate } from "./session-invalidate-activity";
export type ControlSessionHandle = {
  readSessionIdentity?(): Promise<SessionIdentity | undefined>;
};
export type AgentControlCompositionPorts = {
  connection: DaemonConfig;
  runtimeInstanceId: string;
  running(agentId: string): boolean;
  session(agentId: string): ControlSessionHandle | undefined;
  stopAgent(agentId: string): Promise<void>;
  stopAgentJobs?(agentId: string): Promise<void>;
  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    recovery: AgentRecoveryContext | undefined,
    request: LaunchRequest,
  ): Promise<AgentRuntime>;
  launchInFlight(agentId: string): Promise<unknown> | undefined;
  rebind(intent: AgentStartIntent, launchId: string): Promise<SessionIdentity | undefined>;
  stops: Pick<AgentStopRegistry, "forgetSession">;
  dropOwedRecovery(agentId: string): void;
  startSettled(agentId: string): void;
  sendSessionInvalidate?(message: ReturnType<typeof connectionSessionInvalidate>): void;
  reportSession(report: AgentSessionReport): Promise<void>;
  sendControlResult?(result: AgentControlResult): Promise<void>;
  onVersionUnsupported?(provider: RuntimeProvider): void;
  agentControlAccepted?(): boolean;
  transport?(): Pick<
    DaemonConnectionClient,
    "sendSessionInvalidate" | "sendAgentControlResult" | "agentControlAccepted"
  >;
};
export type AgentControlComposition = {
  agentSessions: AgentSessions;
  agentControl: AgentControl;
};
export function composeAgentControl(ports: AgentControlCompositionPorts): AgentControlComposition {
  const { connection, runtimeInstanceId } = ports;
  const state = new AgentRuntimeState(
    new MemoryAgentRuntimeStateStore(connection.workspaceRoot, connection.workspaceId),
  );
  const agentSessions = new AgentSessions(state, async (snapshot) => {
    await ports.reportSession({
      protocolMajor: snapshot.protocolMajor,
      requestId: crypto.randomUUID(),
      workspaceId: snapshot.workspaceId,
      computerId: snapshot.computerId,
      agentId: snapshot.agentId,
      provider: snapshot.provider,
      startRequestId: snapshot.requestId,
      daemonInstanceId: snapshot.daemonInstanceId ?? runtimeInstanceId,
      launchId: snapshot.launchId,
      sessionId: snapshot.identity.sessionId,
      sessionState: snapshot.identity.state,
      controlEpoch: snapshot.epoch,
      sequence: snapshot.sequence,
    });
  });
  const opTiming = new AgentControlOpTiming(runtimeInstanceId);
  const deliverStartInput = async (intent: AgentStartIntent): Promise<void> => {
    await ports.startAgent(
      intent.agentId,
      runtimeConfigOf(intent),
      { wakeMessage: intent.wakeMessage },
      {
        requestId: intent.requestId,
        resumePrompt: intent.resumePrompt,
        introductionPrompt: intent.introductionPrompt,
        fromStart: { agentConfigRevision: intent.agentConfigRevision },
      },
    );
  };
  const keepsStartSession = async (intent: AgentStartIntent): Promise<boolean> => {
    if (!intent.sessionId) return true;
    const running = await ports.session(intent.agentId)?.readSessionIdentity?.();
    if (!running?.sessionId || running.sessionId === intent.sessionId) return true;
    await ports.stopAgent(intent.agentId);
    return false;
  };
  const pendingJobStops = new Map<string, Promise<void>>();
  const agentControl = new AgentControl(runtimeInstanceId, state, agentSessions, {
    running: (agentId) => ports.running(agentId),
    stop: async (agentId) => {
      const session = ports.session(agentId);
      await Promise.all([ports.stopAgent(agentId), pendingJobStops.get(agentId)]);
      return session?.readSessionIdentity?.();
    },
    stopAccepted: (agentId) => {
      ports.dropOwedRecovery(agentId);
      if (!ports.stopAgentJobs) return;
      const stopping = ports.stopAgentJobs(agentId).catch(() => {});
      pendingJobStops.set(agentId, stopping);
      void stopping.finally(() => {
        if (pendingJobStops.get(agentId) === stopping) pendingJobStops.delete(agentId);
      });
    },
    launch: async (intent, launchId, replacedSessionId, invalidateReason) => {
      for (
        let inFlight = ports.launchInFlight(intent.agentId);
        inFlight;
        inFlight = ports.launchInFlight(intent.agentId)
      )
        await inFlight.catch(() => {});
      if (ports.running(intent.agentId) && (await keepsStartSession(intent))) {
        const identity = await ports.rebind(intent, launchId);
        if (carriesStartInput(intent)) await deliverStartInput(intent);
        return identity;
      }
      if (replacedSessionId) ports.stops.forgetSession(intent.agentId);
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
          fromStart: { agentConfigRevision: intent.agentConfigRevision },
          replacedSessionId,
          invalidateReason,
        },
      );
      return runtime.session.readSessionIdentity?.();
    },
    wake: deliverStartInput,
    rebind: (intent, launchId) => ports.rebind(intent, launchId),
    startSettled: (agentId) => ports.startSettled(agentId),
    invalidateSession: (intent, launchId, sessionId, reason) => {
      const msg = connectionSessionInvalidate(connection, runtimeInstanceId, {
        agentId: intent.agentId,
        provider: intent.provider,
        sessionId,
        launchId,
        reason,
      });
      if (ports.sendSessionInvalidate) ports.sendSessionInvalidate(msg);
      else ports.transport?.().sendSessionInvalidate?.(msg);
    },
    result: async (result) => {
      try {
        await (ports.sendControlResult
          ? ports.sendControlResult(result)
          : ports.transport?.().sendAgentControlResult?.(result));
      } finally {
        opTiming.resultSent(result);
      }
    },
    onVersionUnsupported: ports.onVersionUnsupported,
  });
  const accepted = (scope: AgentControlScope) => {
    const enabled = ports.agentControlAccepted
      ? ports.agentControlAccepted()
      : (ports.transport?.().agentControlAccepted?.() ?? false);
    if (!enabled) return;
    const result: AgentControlResult = { ...scope, phase: "accepted", sequence: 1 };
    const send = ports.sendControlResult
      ? ports.sendControlResult(result)
      : (ports.transport?.().sendAgentControlResult?.(result) ?? Promise.resolve());
    void send.catch(() => {}).finally(() => opTiming.resultSent(result));
  };
  const { start, stop, resetWorkspace } = agentControl;
  agentControl.start = (intent) => {
    opTiming.received("start", intent.agentId, intent.requestId);
    if (intent.controlEpoch)
      accepted({
        protocolMajor: 1,
        requestId: intent.requestId,
        workspaceId: intent.workspaceId,
        computerId: intent.computerId,
        agentId: intent.agentId,
        provider: intent.provider,
        epoch: intent.controlEpoch,
      });
    return start.call(agentControl, intent);
  };
  agentControl.stop = (scope) => {
    opTiming.received("stop", scope.agentId, scope.requestId);
    accepted(scope);
    return stop.call(agentControl, scope);
  };
  agentControl.resetWorkspace = (request) => {
    opTiming.received("reset-workspace", request.agentId, request.requestId);
    accepted(request);
    return resetWorkspace.call(agentControl, request);
  };
  return { agentSessions, agentControl };
}
