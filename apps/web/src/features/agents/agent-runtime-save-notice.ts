import { UNDO_TOAST_MS, useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { updateAgent } from "./agents.functions";
import type { AgentRuntimeControls } from "./agent-runtime-controls";

/** What a runtime config save tells the browser about when the Agent picks the change up. */
export type AgentRuntimeSaveOutcome = Pick<Awaited<ReturnType<typeof updateAgent>>, "restart">;

/** Most to least pending work: the outcome earliest here stands for a Save that did several. */
const RESTART_PRIORITY: Array<AgentRuntimeSaveOutcome["restart"]> = [
  "when-idle",
  "deferred",
  "published",
  "not-required",
];

/** One Save can persist the runtime and the environment: the outcome that still has work to do
 * (`when-idle` first) stands for both. */
export function combineRuntimeSaveOutcomes(
  ...outcomes: Array<AgentRuntimeSaveOutcome | undefined>
): AgentRuntimeSaveOutcome | undefined {
  let combined: AgentRuntimeSaveOutcome | undefined;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (
      !combined ||
      RESTART_PRIORITY.indexOf(outcome.restart) < RESTART_PRIORITY.indexOf(combined.restart)
    )
      combined = outcome;
  }
  return combined;
}

/** The one-line toast a saved runtime config earns, if any: a running Agent's save applies later,
 * so it offers Restart now. `canRestart` mirrors who sees the profile's Restart control. */
export function useAgentRuntimeSaveNotice(
  agentId: string,
  controls: Pick<AgentRuntimeControls, "agentName" | "isOnline" | "restartNow">,
  canRestart: boolean,
) {
  const toast = useAppToast();
  const { agentName, isOnline, restartNow } = controls;
  return (outcome: AgentRuntimeSaveOutcome | undefined) => {
    if (!outcome) return;
    let title: string;
    if (outcome.restart === "when-idle") {
      title = m.agent_runtime_saved_when_idle({ name: agentName });
    } else if (outcome.restart === "deferred" && isOnline) {
      title = m.agent_runtime_saved_deferred({ name: agentName });
    } else {
      return;
    }
    toast.success(title, {
      // Longer than a plain confirmation so Restart now can be reached.
      durationMs: UNDO_TOAST_MS,
      key: agentId,
      action: canRestart
        ? { label: m.agent_runtime_restart_now(), onClick: restartNow }
        : undefined,
    });
  };
}
