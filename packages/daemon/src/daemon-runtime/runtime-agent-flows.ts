import type {
  AgentStartIntent,
  AgentStopIntent,
  AgentTurnInterruptIntent,
  AgentWorkspaceResetRequest,
  AgentTurnInterruptResult,
  RuntimeProvider,
  UsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import type {
  AgentTurnInterruptOptions,
  AgentTurnInterruptResult as InterruptOutcome,
} from "#src/agent-runtime/agent-process-manager";
import type { ActivityDraft } from "./agent-activity-publisher";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import {
  observeRuntimeEvent,
  type RuntimeEventObservationPorts,
} from "./runtime-event-observation";
import { canonicalThreadTarget } from "./thread-target";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { ActivityLaunch } from "./activity-launch";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { interruptAgentTurn } from "./turn-interrupt";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentRecoveryContext } from "./runtime-launch-intent";
import type { LaunchRequest } from "./runtime-launch-types";
import { recoveryOf, runtimeConfigOf } from "./runtime-launch-intent";
import { usageScanFailure, usageScanReading, usageScanResult } from "./usage-scan-response";
import { RUNTIME_PROVIDER_USES_EXTERNAL_CLI } from "@lrm/coforge-sdk/internal";

/** How long a usage read may take before the scan reports it as failed. */
export const USAGE_SCAN_READ_TIMEOUT_MS = 10_000;

/** What one turn interrupt needs from the runtime that owns the launch. */
export type AgentTurnInterruptPorts = {
  assertOwnIntent(intent: AgentTurnInterruptIntent): void;
  launch(agentId: string): ActivityLaunch | undefined;
  interrupt(agentId: string, options: AgentTurnInterruptOptions): Promise<InterruptOutcome>;
  publish(agentId: string, launch: ActivityLaunch, draft: ActivityDraft): void;
  activity(agentId: string, detailKind: string, level: "info", detail: string): ActivityDraft;
  interruptedDraft(agentId: string): ActivityDraft;
  report: ((result: AgentTurnInterruptResult) => Promise<void>) | undefined;
};

/** Stops only the current turn of the launch the intent names, reporting what happened. */
export async function handleAgentTurnInterrupt(
  ports: AgentTurnInterruptPorts,
  intent: AgentTurnInterruptIntent,
): Promise<void> {
  ports.assertOwnIntent(intent);
  await interruptAgentTurn(
    {
      launch: (agentId) => ports.launch(agentId),
      interrupt: (agentId, options) => ports.interrupt(agentId, options),
      publish: (agentId, launch, outcome) =>
        ports.publish(
          agentId,
          launch,
          outcome === "restarted"
            ? ports.activity(
                agentId,
                AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
                "info",
                "Stopping this turn: restarting the runtime",
              )
            : ports.interruptedDraft(agentId),
        ),
      report: ports.report,
    },
    intent,
  );
}

/** What one usage scan needs from the runtime whose providers it reads. */
export type UsageScanPorts = {
  assertRunning(): void;
  workspaceRoot: string;
  createProvider(provider: RuntimeProvider): {
    readUsage?(options: { workingDirectory: string; timeoutMs: number }): Promise<unknown>;
  };
  observedUsage(provider: RuntimeProvider): Parameters<typeof usageScanReading>[0];
};

/** Reads one provider's usage, or says why it cannot: never claims the product has no endpoint. */
export async function scanUsage(
  ports: UsageScanPorts,
  provider: RuntimeProvider,
): Promise<UsageScanResponse> {
  ports.assertRunning();
  const now = () => new Date();
  // Cursor, OpenCode, Pi, and CoForge have no reader yet. Say that the reader is not connected.
  // Do not claim the official product has no quota endpoint.
  if (!RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider])
    return usageScanResult("unsupported", undefined, "Usage reader is not connected yet");
  const codeAgentProvider = ports.createProvider(provider);
  if (!codeAgentProvider.readUsage)
    return usageScanResult("unsupported", undefined, "Usage reader is not connected yet");
  try {
    const snapshot =
      ((await codeAgentProvider.readUsage({
        workingDirectory: ports.workspaceRoot,
        timeoutMs: USAGE_SCAN_READ_TIMEOUT_MS,
      })) as Parameters<typeof usageScanReading>[0] | undefined) ?? ports.observedUsage(provider);
    return usageScanReading(snapshot, now);
  } catch (error) {
    return usageScanFailure(error, () => ports.observedUsage(provider), now);
  }
}

/** What the control-intent handlers need from the runtime that owns the Agents. */
export type AgentControlIntentPorts = {
  assertOwnIntent(intent: AgentStartIntent | AgentStopIntent): void;
  connection: { workspaceId: string; computerId: string };
  started: boolean;
  stopping: boolean;
  controlStart(intent: AgentStartIntent): Promise<void>;
  controlStop(
    intent: AgentStopIntent & { provider: RuntimeProvider; epoch: number },
  ): Promise<void>;
  replaySession(agentId: string): Promise<void>;
  runtime(agentId: string): AgentRuntime | undefined;
  managed(agentId: string): boolean;
  pendingStop(agentId: string): Promise<void> | undefined;
  startAgent(
    agentId: string,
    config: AgentRuntimeConfig,
    recovery: AgentRecoveryContext,
    request: LaunchRequest,
  ): Promise<AgentRuntime>;
  stopAgent(agentId: string): Promise<void>;
  resetWorkspace(request: AgentWorkspaceResetRequest): Promise<void>;
};

/** A server Start: fenced through AgentControl, or an unfenced launch when no control epoch came. */
export async function handleAgentStart(
  ports: AgentControlIntentPorts,
  intent: AgentStartIntent,
): Promise<AgentRuntime> {
  ports.assertOwnIntent({
    ...intent,
    computerId: intent.computerId || ports.connection.computerId,
  });
  if (intent.controlEpoch) {
    await ports.controlStart(intent);
    await ports.replaySession(intent.agentId);
    const runtime = ports.runtime(intent.agentId);
    if (!runtime) throw new Error("Agent managed launch did not complete");
    return runtime;
  }
  if (ports.managed(intent.agentId)) throw new Error("Agent requires a fenced Start");
  const stopping = ports.pendingStop(intent.agentId);
  if (stopping) await stopping;
  return ports.startAgent(intent.agentId, runtimeConfigOf(intent), recoveryOf(intent), {
    sessionId: intent.sessionId,
    requestId: intent.requestId,
    previousLaunchId: intent.previousLaunchId,
    sessionMode: intent.sessionMode,
    resumePrompt: intent.resumePrompt,
    introductionPrompt: intent.introductionPrompt,
  });
}

/** A server Stop: fenced through AgentControl, or the ordinary stop of an unmanaged Agent. */
export async function handleAgentStop(
  ports: AgentControlIntentPorts,
  intent: AgentStopIntent,
): Promise<void> {
  ports.assertOwnIntent(intent);
  if (intent.provider !== undefined && intent.controlEpoch !== undefined) {
    await ports.controlStop({
      ...intent,
      provider: intent.provider,
      epoch: intent.controlEpoch,
    });
    return;
  }
  if (ports.managed(intent.agentId)) throw new Error("Agent requires a fenced Stop");
  await ports.stopAgent(intent.agentId);
}

/** A server workspace reset: only for this runtime's own, started, not-stopping scope. */
export async function handleAgentWorkspaceReset(
  ports: AgentControlIntentPorts,
  request: AgentWorkspaceResetRequest,
): Promise<void> {
  if (
    !ports.started ||
    ports.stopping ||
    request.workspaceId !== ports.connection.workspaceId ||
    request.computerId !== ports.connection.computerId
  )
    throw new Error("Agent control scope unavailable");
  await ports.resetWorkspace(request);
}

/** The launch-event gate: a late trajectory flush must not touch the replacement launch. */
export function observeLaunchEvent(
  ports: {
    currentLaunch(agentId: string): ActivityLaunch | undefined;
    observation: RuntimeEventObservationPorts;
  },
  agentId: string,
  launch: ActivityLaunch,
  config: AgentRuntimeConfig,
  runtime: AgentRuntime,
  controlled: boolean,
  event: AgentRuntimeEvent,
): void {
  if (ports.currentLaunch(agentId) !== launch) return;
  observeRuntimeEvent(ports.observation, agentId, launch, config, runtime, controlled, event);
}

/** Resolves a thread target to its parent plus anchor by reading that parent once. */
export function canonicalAgentMessageTarget(
  ports: {
    workspaceId: string;
    readMessage: NonNullable<DaemonConnectionClient["agentMessage"]>;
  },
  agentId: string,
  target: string,
  agentApiKey: string,
): Promise<string> {
  return canonicalThreadTarget(target, (parent, anchor) =>
    ports.readMessage(
      {
        idempotencyKey: crypto.randomUUID(),
        agentId,
        workspaceId: ports.workspaceId,
        operation: "read",
        target: parent,
        around: anchor,
        limit: 1,
      },
      agentApiKey,
    ),
  );
}
