import { getLogger } from "@logtape/logtape";
import type { AgentTurnInterruptIntent, AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import type {
  AgentTurnInterruptOptions,
  AgentTurnInterruptResult as InterruptOutcome,
} from "#src/agent-runtime/agent-process-manager";
import type { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import type { SubagentWakeTracker } from "#src/agent-runtime/subagent-progress-activity";
import type { ProviderProgress } from "./stalled-recovery";
import type { StalledTurnTracker } from "./stalled-turn-indicator";

/** How long the provider gets to end the turn itself before its runtime is restarted. */
export const AGENT_TURN_INTERRUPT_TIMEOUT_MS = 10_000;
/** How long the restart's graceful release gets before the turn-scoped forced kill. */
export const AGENT_TURN_INTERRUPT_RELEASE_TIMEOUT_MS = 5_000;

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** An interrupt the daemon received and answered. Identity and outcome only: the intent carries
 * no user content, and this line is what tells a server-requested stop apart from a teardown the
 * daemon started on its own (task #630). */
function logAccepted(intent: AgentTurnInterruptIntent, status: string): void {
  logger.info("Agent turn interrupt accepted", {
    event: "agent_turn_interrupt:accepted",
    request_id: intent.requestId,
    agent_id: intent.agentId,
    launch_id: intent.launchId,
    status,
    outcome: "accepted",
  });
}

/** The slice of a launch's Activity state a turn interrupt reads and settles. */
export type TurnInterruptLaunch = Readonly<{
  launchId: string;
  replyIntents?: { clear(): void };
  stalled?: StalledTurnTracker;
  progress?: ProviderProgress;
  toolCalls?: ToolCallLedger;
  /** Present on providers that wake after subagents; a user stop is remembered here. */
  subagentWake?: Pick<SubagentWakeTracker, "noteUserStop">;
}>;

export type TurnInterruptHost<Launch extends TurnInterruptLaunch> = Readonly<{
  launch(agentId: string): Launch | undefined;
  interrupt(agentId: string, options: AgentTurnInterruptOptions): Promise<InterruptOutcome>;
  /** Per-subagent stop; absent ports report the request as unsupported. */
  interruptSubagent?(
    agentId: string,
    taskId: string,
  ): Promise<"interrupted" | "not_running" | "unsupported">;
  /** Shows that the turn was stopped, or that the runtime restarts to stop it. */
  publish(agentId: string, launch: Launch, outcome: "interrupted" | "restarted"): void;
  report: ((result: AgentTurnInterruptResult) => Promise<void>) | undefined;
}>;

/**
 * The oldest instant whose children the turn-scoped kill may take: the turn's own start, or an
 * older open tool call. Anything that started earlier is not part of this turn. It is on the host
 * process clock, as stamped when the turn or call began, never converted from wall time.
 */
export function turnInterruptCutoffAtMs(launch: TurnInterruptLaunch): number | undefined {
  const turnStartedAtMs = launch.progress?.turnStartedProcessClockMs;
  const oldestToolStartedAtMs = launch.toolCalls?.oldestOpenToolStartedProcessClockMs();
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
    logAccepted(intent, "not_running");
    await host.report?.({ ...intent, status: "not_running" });
    return;
  }
  // A subagent stop touches no turn state: no reply intents to retract, no stalled turn to
  // settle, no restart — the main turn keeps running.
  if (intent.subagentTaskId !== undefined) {
    const status =
      (await host.interruptSubagent?.(intent.agentId, intent.subagentTaskId)) ?? "unsupported";
    logAccepted(intent, status);
    // A task the user stopped is not an unread result: its ending must not wake the Agent.
    if (status === "interrupted") launch.subagentWake?.noteUserStop(intent.subagentTaskId);
    await host.report?.({ ...intent, status });
    return;
  }
  launch.replyIntents?.clear();
  launch.stalled?.finish(intent.agentId, "turn_interrupted");
  const status = await host.interrupt(intent.agentId, {
    interruptTimeoutMs: AGENT_TURN_INTERRUPT_TIMEOUT_MS,
    releaseTimeoutMs: AGENT_TURN_INTERRUPT_RELEASE_TIMEOUT_MS,
    cutoffAtMs: turnInterruptCutoffAtMs(launch),
    // The daemon-side timeout line names the request that asked for this stop.
    identity: { requestId: intent.requestId, launchId: intent.launchId },
  });
  logAccepted(intent, status);
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
