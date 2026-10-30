import type { ActivityDraft } from "./agent-activity-publisher";
import {
  idleActivityDraft,
  interruptedActivityDraft,
  quietTurnActivityDraft,
  runtimeErrorActivityDraft,
  startingActivityDraft,
  stoppedActivityDraft,
} from "./activity-draft";

/**
 * The Activity drafts that only add this Computer's workspace: a launch starting, an Agent at idle
 * or stopped, a turn cut by a requested stop/restart, a quiet turn end, and a runtime error. One
 * instance is bound once per runtime and reused by every Agent.
 */
export function agentActivityDrafts(workspaceId: string) {
  return {
    starting: (agentId: string): ActivityDraft => startingActivityDraft(workspaceId, agentId),
    idle: (agentId: string): ActivityDraft => idleActivityDraft(workspaceId, agentId),
    stopped: (agentId: string): ActivityDraft => stoppedActivityDraft(workspaceId, agentId),
    interrupted: (agentId: string): ActivityDraft => interruptedActivityDraft(workspaceId, agentId),
    quietTurn: (agentId: string, backgroundDetail: string | undefined): ActivityDraft =>
      quietTurnActivityDraft(workspaceId, agentId, backgroundDetail),
    runtimeError: (
      agentId: string,
      detail: string,
      runtimeError?: ActivityDraft["runtimeError"],
    ): ActivityDraft => runtimeErrorActivityDraft(workspaceId, agentId, detail, runtimeError),
  };
}
