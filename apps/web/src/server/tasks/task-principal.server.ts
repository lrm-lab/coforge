import type { TaskPrincipal } from "@lrm/coforge-sdk/internal";

/** The Agent as the actor on a board. */
export type AgentTaskPrincipal = Extract<TaskPrincipal, { agentId: string }>;

/**
 * The one way an Agent API request becomes a task principal: the Agent alone. What the API
 * authenticates names the Agent's owner beside it (`userId`), and the board refuses a principal
 * that names both. Every task route goes through this, and the handlers take `AgentTaskPrincipal`,
 * so the authenticated principal cannot be passed on as it is.
 */
export function agentTaskPrincipal(principal: {
  workspaceId: string;
  agentId: string;
}): AgentTaskPrincipal {
  return { workspaceId: principal.workspaceId, agentId: principal.agentId };
}
