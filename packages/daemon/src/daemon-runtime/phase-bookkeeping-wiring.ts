import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import type { ActivityDraft } from "./agent-activity-publisher";
import type { ActivityLaunch } from "./activity-launch";
import { PhaseBookkeeping, type PhaseBookkeepingPorts } from "./phase-bookkeeping";

/**
 * Assembles a launch's phase bookkeeping from the runtime's own callbacks: where its Activity goes,
 * where the current launch is, and the context a finished compaction starts over. Kept out of the
 * runtime so that wiring another port (a compaction failure ledger, a stop) does not grow it — the
 * runtime file is at its size limit.
 */
export function assemblePhaseBookkeeping(
  contexts: PhaseBookkeepingPorts["contexts"],
  currentLaunch: (agentId: string) => ActivityLaunch | undefined,
  publish: (agentId: string, launch: ActivityLaunch, draft: ActivityDraft) => void,
  activity: (agentId: string, kind: AgentActivity["detailKind"], detail: string) => ActivityDraft,
  contextUsage?: (
    agentId: string,
  ) => { usedTokens: number; windowTokens: number; observedAtMs: number } | undefined,
): PhaseBookkeeping {
  return new PhaseBookkeeping({
    contexts,
    launchFor: (agentId) => currentLaunch(agentId),
    publish: (agentId, launch, draft) => publish(agentId, launch, draft),
    activityDraft: (agentId, detailKind, detail) => activity(agentId, detailKind, detail),
    contextUsage,
  });
}
