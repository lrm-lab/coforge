import type { AgentDisplay } from "./agent-display.server";
import type { AgentStopReasonRecorder } from "./agent-control-receiver.server";
import {
  AGENT_VISIBILITY,
  normalizeAgentVisibility,
} from "#src/features/agents/agent-visibility";
import {
  agentStatusChannelFor,
  publishAgentDisplay,
} from "#src/features/agents/agent-status-channel";

/**
 * The display write a settled control failure owes, plus its realtime fan-out: the same
 * snapshot publication every other display writer performs, so an Agent whose launch failed
 * on a path that never sent a runtime_error Activity still shows its reason without a reload.
 * Best-effort like the Activity path's own publish — a Centrifugo failure never rejects the
 * already-accepted control result.
 */
export function createAgentStopReasonRecorder(dependencies: {
  display: Pick<AgentDisplay, "recordStopReason">;
  publishJson: (channel: string, data: unknown) => Promise<void>;
}): AgentStopReasonRecorder {
  return async (agent, reason) => {
    const visibility = normalizeAgentVisibility(agent.visibility);
    const snapshot = await dependencies.display.recordStopReason(
      {
        workspaceId: agent.workspaceId,
        computerId: agent.computerId,
        agentId: agent.id,
      },
      reason,
    );
    if (!snapshot) return;
    await publishAgentDisplay(
      dependencies.publishJson,
      agentStatusChannelFor(agent.workspaceId, agent.id, visibility),
      snapshot,
      visibility !== AGENT_VISIBILITY.PUBLIC,
    );
  };
}
