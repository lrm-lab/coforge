import type { AgentTurnInterruptIntent, AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import type {
  AgentTurnInterruptOptions,
  AgentTurnInterruptResult as InterruptOutcome,
} from "#src/agent-runtime/agent-process-manager";
import type { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import type { ProviderProgress } from "./stalled-recovery";
import type { StalledTurnTracker } from "./stalled-turn-indicator";

/** How long the provider gets to end the turn itself before its runtime is restarted. */
export const AGENT_TURN_INTERRUPT_TIMEOUT_MS = 10_000;
/** How long the restart's graceful release gets before the turn-scoped forced kill. */
export const AGENT_TURN_INTERRUPT_RELEASE_TIMEOUT_MS = 5_000;

/** The slice of a launch's Activity state a turn interrupt reads and settles. */
export type TurnInterruptLaunch = Readonly<{
  launchId: string;
  replyIntents?: { clear(): void };
  stalled?: StalledTurnTracker;
  progress?: ProviderProgress;
  toolCalls?: ToolCallLedger;
}>;

export type TurnInterruptHost<Launch extends TurnInterruptLaunch> = Readonly<{
  launch(agentId: string): Launch | undefined;
  interrupt(agentId: string, options: AgentTurnInterruptOptions): Promise<InterruptOutcome>;
  /** Shows that the turn was stopped, or that the runtime restarts to stop it. */
  publish(agentId: string, launch: Launch, outcome: "interrupted" | "restarted"): void;
  report: ((result: AgentTurnInterruptResult) => Promise<void>) | undefined;
}>;

/**
 * The oldest instant whose children the turn-scoped kill may take: the turn's own start, or an
 * older open tool call. Anything that started earlier is not part of this turn.
 */
export function turnInterruptCutoffAtMs(launch: TurnInterruptLaunch): number | undefined {
  const turnStartedAtMs = launch.progress?.turnStartedAtMs;
  const oldestToolStartedAtMs = launch.toolCalls?.oldestOpenToolStartedAtMs();
  if (turnStartedAtMs === undefined) return oldestToolStartedAtMs;
  return oldestToolStartedAtMs === undefined
    ? turnStartedAtMs
    : Math.min(turnStartedAtMs, oldestToolStartedAtMs);
}

/** Stops only the current turn of the launch the intent names, and reports what happened. */
export async function interruptAgentTurn<Launch extends TurnInterruptLaunch>(
  host: TurnInterruptHost<Launch>,
  intent: AgentTurnInterruptIntent,
): Promise<void> {
  const launch = host.launch(intent.agentId);
  if (!launch || launch.launchId !== intent.launchId) {
    await host.report?.({ ...intent, status: "not_running" });
    return;
  }
  launch.replyIntents?.clear();
  launch.stalled?.finish(intent.agentId);
  const status = await host.interrupt(intent.agentId, {
    interruptTimeoutMs: AGENT_TURN_INTERRUPT_TIMEOUT_MS,
    releaseTimeoutMs: AGENT_TURN_INTERRUPT_RELEASE_TIMEOUT_MS,
    cutoffAtMs: turnInterruptCutoffAtMs(launch),
  });
  // The restart may have replaced the launch; read the live one for what to show and report.
  const current = host.launch(intent.agentId);
  if (current && status !== "not_running") host.publish(intent.agentId, current, status);
  const tool = current?.toolCalls?.oldestOpenTool();
  const silentForMs = current?.progress?.silentForMs();
  await host.report?.({
    ...intent,
    status,
    ...(tool ? { toolName: tool.name } : {}),
    ...(silentForMs !== undefined ? { silentForMs } : {}),
  });
}
