import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { MAX_LIVE_EXTERNAL_CREDENTIALS } from "#src/server/agents/external-agent-credentials.server";
import { externalAgentManagerAccess } from "#src/server/agents/external-agent-access.server";
import { WORKSPACE_ADMIN_ROLES } from "#src/features/workspaces/workspace-roles";
import type { ExternalAgentDeviceDirectory } from "#src/server/auth/device-auth-external-agent.server";

const APPROVABLE_LIMIT = 200;

export class PrismaExternalAgentDeviceDirectory implements ExternalAgentDeviceDirectory {
  constructor(private readonly db: PrismaClient) {}

  async target(agentId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, ...ACTIVE_AGENT_WHERE },
      select: { workspaceId: true, hosting: true },
    });
    return agent ?? undefined;
  }

  async approvable(userId: string) {
    const agents = await this.db.agent.findMany({
      where: {
        hosting: "external",
        stoppedAt: null,
        ...ACTIVE_AGENT_WHERE,
        OR: [
          { ownerId: userId, workspace: { members: { some: { userId } } } },
          {
            workspace: { members: { some: { userId, role: { in: [...WORKSPACE_ADMIN_ROLES] } } } },
          },
        ],
      },
      orderBy: [{ workspace: { name: "asc" } }, { name: "asc" }, { id: "asc" }],
      take: APPROVABLE_LIMIT,
      select: {
        id: true,
        name: true,
        displayName: true,
        workspaceId: true,
        workspace: { select: { name: true, slug: true } },
      },
    });
    return agents.map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      workspaceId: agent.workspaceId,
      workspaceName: agent.workspace.name,
      workspaceSlug: agent.workspace.slug,
    }));
  }

  async identity(workspaceId: string, agentId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: {
        name: true,
        displayName: true,
        workspace: { select: { name: true, slug: true } },
      },
    });
    return agent
      ? {
          agent: { name: agent.name, displayName: agent.displayName },
          workspace: agent.workspace,
        }
      : undefined;
  }

  async approvalRefusal(input: { userId: string; workspaceId: string; agentId: string }) {
    const access = await externalAgentManagerAccess(this.db, input);
    if (!access.ok) return "not_authorized" as const;
    if (access.agent.hosting !== "external") return "agent_not_external" as const;
    if (access.agent.deletedAt || access.agent.stoppedAt) return "agent_unavailable" as const;
    const live = await this.db.externalAgentCredential.count({
      where: { agentId: input.agentId, revokedAt: null },
    });
    if (live >= MAX_LIVE_EXTERNAL_CREDENTIALS) return "credential_limit" as const;
    return undefined;
  }
}
