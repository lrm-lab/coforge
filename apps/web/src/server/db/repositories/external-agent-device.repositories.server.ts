import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { MAX_LIVE_EXTERNAL_CREDENTIALS } from "#src/server/agents/external-agent-credentials.server";
import { externalAgentManagerAccess } from "#src/server/agents/external-agent-access.server";
import type { ExternalAgentDeviceDirectory } from "#src/server/auth/device-auth-external-agent.server";

export class PrismaExternalAgentDeviceDirectory implements ExternalAgentDeviceDirectory {
  constructor(private readonly db: PrismaClient) {}

  async resolve(workspaceSlug: string, agentName: string) {
    const agent = await this.db.agent.findFirst({
      where: { name: agentName, workspace: { slug: workspaceSlug }, ...ACTIVE_AGENT_WHERE },
      select: { id: true, workspaceId: true, hosting: true },
    });
    return agent
      ? { workspaceId: agent.workspaceId, agentId: agent.id, hosting: agent.hosting }
      : undefined;
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
    // Refused at approval rather than after the code is spent, so nobody approves for nothing.
    const live = await this.db.externalAgentCredential.count({
      where: { agentId: input.agentId, revokedAt: null },
    });
    if (live >= MAX_LIVE_EXTERNAL_CREDENTIALS) return "credential_limit" as const;
    return undefined;
  }
}
