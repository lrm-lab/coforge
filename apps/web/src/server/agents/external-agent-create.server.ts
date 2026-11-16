import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { AGENT_VISIBILITY, type AgentVisibility } from "#src/features/agents/agent-visibility";
import type { AgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { logAgentCreated } from "#src/server/conversations/direct-conversation-log.server";
import {
  assertCanCreateAgents,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";
import { agentRuntimeConfig } from "./agent-runtime-config.server";

export type ExternalAgentCreateInput = {
  hosting: "external";
  name: string;
  displayName?: string;
  description: string;
  visibility?: AgentVisibility;
  createRequestId?: string;
};

export const EXTERNAL_AGENT_RUNTIME_CONFIG = agentRuntimeConfig(
  { provider: RUNTIME_PROVIDER.CLAUDE_CODE, model: "", modelProvider: "", reasoning: "" },
  { kind: "default" },
);

export async function createExternalAgent(
  agents: Pick<AgentRepository, "create">,
  principal: { userId: string; workspaceId: string; role?: WorkspaceMemberRole },
  input: ExternalAgentCreateInput,
) {
  if (!principal.role) throw new AppError("ACCESS_DENIED");
  assertCanCreateAgents(principal.role);
  const name = input.name.trim().toLowerCase();
  if (!name) throw new AppError("INVALID_INPUT", { errorId: "agent-name-required" });
  const agent = await agents.create({
    workspaceId: principal.workspaceId,
    ownerId: principal.userId,
    name,
    displayName: input.displayName?.trim() || name,
    description: input.description.trim(),
    hosting: "external",
    visibility: input.visibility ?? AGENT_VISIBILITY.PUBLIC,
    ...(input.createRequestId ? { createRequestId: input.createRequestId } : {}),
    runtimeConfig: EXTERNAL_AGENT_RUNTIME_CONFIG,
  });
  logAgentCreated({
    workspaceId: principal.workspaceId,
    agentId: agent.id,
    creatorUserId: principal.userId,
    hosting: "external",
  });
  return { agent, startPublished: false as const };
}
