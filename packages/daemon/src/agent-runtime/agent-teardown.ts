import { AgentProcessCleanupError, scrubRuntimeErrorText } from "@lrm/coforge-anvil";
import { refusalText } from "@lrm/coforge-sdk/internal";
import { reclaimAgentLaunchTagStrays } from "#src/daemon-runtime/agent-launch-tags";
import { straySurvivors } from "#src/platform/agent-launch-tag-sweep";

/** How far an Agent's teardown got. `stopping` is in flight; `failed` and `exit-failed` mean it
 * could not confirm the process exited (a Stop's dispose, and an exit whose process tree it could
 * not collect, respectively) — both retryable, both re-cleared by the next Start (#704, #705). */
export type AgentTeardown = "stopping" | "failed" | "exit-failed";

/** The marks that hide the runtime from the daemon's liveness questions and gate the next Start on
 * clearing what the failed teardown left. */
export const UNCLEARED = new Set<AgentTeardown>(["failed", "exit-failed"]);

/** A dispose that could not confirm exit keeps the runtime's own words, so the refusal a person
 * reads says why the old process is still there (task #705). */
export function throwStopFailure(error: unknown): never {
  throw new AgentProcessCleanupError(scrubRuntimeErrorText(refusalText(error)));
}

/** The evidence a Start or a Stop needs before it may treat a failed teardown as settled. */
export async function confirmGone(agentId: string): Promise<void> {
  const survivors = straySurvivors(await reclaimAgentLaunchTagStrays(agentId));
  if (survivors.length > 0)
    throw new AgentProcessCleanupError(
      `${survivors.length} process(es) from its previous launch are still running`,
    );
}
