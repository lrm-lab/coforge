import type {
  AgentControlResult,
  AgentSessionReport,
  AgentStartIntent,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentRuntimeState } from "#src/agent-runtime/agent-runtime-state";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import { MemoryAgentRuntimeStateStore } from "#src/persistence/memory-agent-runtime-state-store";
import type { DaemonConfig } from "./runtime";
import { recoveryOf, runtimeConfigOf, type AgentRecoveryContext } from "./runtime-launch-intent";
import type { LaunchRequest } from "./runtime-launch-types";
import { connectionSessionInvalidate } from "./session-invalidate-activity";

/** A live Agent process's Session handle, as the control seam reads it. */
export type ControlSessionHandle = {
  readSessionIdentity?(): Promise<SessionIdentity | undefined>;
};

/** What the runtime supplies to one Agent's control and Session state. */
export type AgentControlCompositionPorts = {
  connection: DaemonConfig;
  runtimeInstanceId: string;
  /** Whether this Agent currently has a live process. */
  running(agentId: string): boolean;
  /** The Agent's live process Session, read before a stop releases it. */
  session(agentId: string): ControlSessionHandle | undefined;
  stopAgent(agentId: string): Promise<void>;
  /** One launch under the given identity, with the Session, Activity and exit callbacks it owns. */
  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    recovery: AgentRecoveryContext | undefined,
    request: LaunchRequest,
  ): Promise<AgentRuntime>;
  /** Rebinds an already-running process to a newer control scope. */
  rebind(intent: AgentStartIntent, launchId: string): Promise<SessionIdentity | undefined>;
  /** Forgets the Session reference of a launch that starts over under a fresh session. */
  forgetSessionReference(agentId: string): void;
  /** A Start that was pending for this Agent no longer is. */
  startSettled(agentId: string): void;
  /** Sends the stale-session report this Agent's control decision produced. */
  sendSessionInvalidate(message: ReturnType<typeof connectionSessionInvalidate>): void;
  reportSession(report: AgentSessionReport): Promise<void>;
  sendControlResult(result: AgentControlResult): Promise<void>;
};

export type AgentControlComposition = {
  agentSessions: AgentSessions;
  agentControl: AgentControl;
};

/**
 * Builds one Workspace runtime's Agent control and Session state: the control records, the
 * `agent:session` report each accepted snapshot produces, and the ports through which control
 * launches, stops, wakes and rebinds Agents. `DaemonRuntime` keeps the collaborators those ports
 * call and hands them in here.
 */
export function composeAgentControl(ports: AgentControlCompositionPorts): AgentControlComposition {
  const { connection, runtimeInstanceId } = ports;
  const state = new AgentRuntimeState(
    // Control state lives only in this process: the server
    // re-dispatches what should still be running after a restart, so a persisted record could
    // only outlive the writer it was waiting on.
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
  const agentControl = new AgentControl(runtimeInstanceId, state, agentSessions, {
    running: (agentId) => ports.running(agentId),
    stop: async (agentId) => {
      const session = ports.session(agentId);
      await ports.stopAgent(agentId);
      return session?.readSessionIdentity?.();
    },
    launch: async (intent, launchId, replacedSessionId, invalidateReason) => {
      if (replacedSessionId) ports.forgetSessionReference(intent.agentId);
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
    wake: async (intent) => {
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
    rebind: (intent, launchId) => ports.rebind(intent, launchId),
    startSettled: (agentId) => ports.startSettled(agentId),
    // `launchId` is always present here (minted synchronously by `AgentControl.start()` before
    // this call); the wire message and the retry's cold-start Activity (`#launchAgent`'s
    // `request.invalidateReason` narration) both follow that same, effectively-unconditional
    // signal — there is no longer a separate controlEpoch gate.
    invalidateSession: (intent, launchId, sessionId, reason) => {
      ports.sendSessionInvalidate(
        connectionSessionInvalidate(connection, runtimeInstanceId, {
          agentId: intent.agentId,
          provider: intent.provider,
          sessionId,
          launchId,
          reason,
        }),
      );
    },
    result: (result) => ports.sendControlResult(result),
  });
  return { agentSessions, agentControl };
}
