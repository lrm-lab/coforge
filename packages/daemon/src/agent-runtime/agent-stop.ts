import type { AgentSession } from "@coforge/agent";
import { withDeadline } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";
import { reclaimAgentLaunchTagStrays } from "#src/daemon-runtime/agent-launch-tags";
import {
  straySurvivors,
  type AgentLaunchTagSweepReport,
} from "#src/platform/agent-launch-tag-sweep";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How long a stop waits for the provider's own teardown before it forces the process tree down:
 * the tree cleanup's polite wait and forced wait, plus slack for draining output. */
export const AGENT_STOP_DEADLINE_MS = 25_000;

/** How long the launch-tag sweep that follows an unfinished teardown may run, and how long a Start
 * waits on the sweep that precedes its launch. */
export const AGENT_STOP_SWEEP_DEADLINE_MS = 5_000;

export type AgentStopSettings = Readonly<{
  deadlineMs: number;
  sweepDeadlineMs: number;
  /** Signals every process carrying the Agent's launch tag, sparing none. */
  sweep: (agentId: string) => Promise<AgentLaunchTagSweepReport>;
}>;

export const DEFAULT_AGENT_STOP_SETTINGS: AgentStopSettings = {
  deadlineMs: AGENT_STOP_DEADLINE_MS,
  sweepDeadlineMs: AGENT_STOP_SWEEP_DEADLINE_MS,
  sweep: reclaimAgentLaunchTagStrays,
};

/**
 * Ends one session without ever rejecting or waiting past the deadline. The provider's own
 * dispose runs first; when it fails or runs out of time, every process carrying the Agent's launch
 * tag is signalled to exit and then killed, and the stop stops waiting. Resolves true when the
 * provider confirmed the teardown or the sweep left no survivor, false when a process is still
 * there; that is logged with its pids and never thrown.
 */
export async function stopSession(
  agentId: string,
  session: AgentSession,
  settings: AgentStopSettings,
): Promise<boolean> {
  // An async wrapper, so a dispose that throws before it returns a promise is a failure too.
  const disposing = (async () => session.dispose())();
  // An abandoned dispose may still fail later; nobody is waiting for that.
  disposing.catch(() => undefined);
  const ended = await withDeadline(
    disposing,
    settings.deadlineMs,
    () => new Error("deadline"),
  ).then(
    () => undefined,
    (error: unknown) =>
      error instanceof Error && error.message === "deadline" ? "timeout" : "failed",
  );
  if (ended === undefined) return true;
  logger.warning("Agent teardown did not finish; forcing the process tree down", {
    event: "agent_runtime:stop_forced",
    agent_id: agentId,
    reason: ended,
  });
  const survivors = await sweepStrays(agentId, settings);
  if (survivors.length === 0) return true;
  logger.warning("Agent stop did not confirm that every process exited", {
    event: "agent_runtime:stop_unconfirmed",
    agent_id: agentId,
    survivors,
    outcome: "unconfirmed",
  });
  return false;
}

/** What a bounded launch-tag sweep could not take down, by pid and reason; empty when it cleared
 * everything. A sweep that fails or does not finish in time is one survivor with pid 0. Never
 * rejects. */
export async function sweepStrays(
  agentId: string,
  settings: Pick<AgentStopSettings, "sweep" | "sweepDeadlineMs">,
): Promise<AgentLaunchTagSweepReport["unkilled"]> {
  const report = await withDeadline(
    (async () => settings.sweep(agentId))(),
    settings.sweepDeadlineMs,
    () => new Error("deadline"),
  ).catch(() => undefined);
  return report ? straySurvivors(report) : [{ pid: 0, reason: "sweep_unfinished" }];
}
