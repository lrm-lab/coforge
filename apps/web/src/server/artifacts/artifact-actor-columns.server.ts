import type { ArtifactActor } from "./artifact-access.server";

export function commentColumns(actor: ArtifactActor) {
  return actor.agentId !== undefined
    ? ({
        author: { authorAgentId: actor.agentId },
        resolver: { resolvedByAgentId: actor.agentId, resolvedByUserId: null },
        key: `agent:${actor.agentId}`,
      } as const)
    : ({
        author: { authorUserId: actor.userId },
        resolver: { resolvedByUserId: actor.userId, resolvedByAgentId: null },
        key: `user:${actor.userId}`,
      } as const);
}
