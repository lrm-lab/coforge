import { buildExternalAgentGuide } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { resolveActorServerRole } from "#src/server/conversations/channel-authority.server";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { externalAgentFeatures } from "./external-agent-capabilities.server";

export type AgentContextResponse = {
  agent: {
    id: string;
    name: string;
    displayName: string;
    description: string;
    role: string;
    external: boolean;
  };
  workspace: { id: string; slug: string; name: string };
  credential: { id: string } | null;
  capabilities: string[] | null;
  prompt: { text: string } | null;
};

export async function readAgentContext(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string; credentialId?: string; external?: true },
): Promise<AgentContextResponse | undefined> {
  const [agent, workspace, serverRole] = await Promise.all([
    db.agent.findFirst({
      where: { id: principal.agentId, workspaceId: principal.workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { id: true, name: true, displayName: true, description: true, role: true },
    }),
    db.workspace.findUnique({
      where: { id: principal.workspaceId },
      select: { id: true, slug: true, name: true },
    }),
    resolveActorServerRole(db, principal.workspaceId, { agentId: principal.agentId }),
  ]);
  if (!agent || !workspace) return undefined;
  const resolvedAgent = {
    ...agent,
    role: serverRole ?? agent.role,
    external: principal.external === true,
  };
  return {
    agent: resolvedAgent,
    workspace,
    credential: principal.credentialId ? { id: principal.credentialId } : null,
    capabilities: principal.external ? externalAgentFeatures() : null,
    prompt: principal.external
      ? { text: buildExternalAgentGuide({ agent: resolvedAgent, workspace }) }
      : null,
  };
}
