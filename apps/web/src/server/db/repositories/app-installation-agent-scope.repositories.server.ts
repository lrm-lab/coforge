import type { PrismaClient } from "#src/generated/prisma/client";
import { allowedGrantScopes } from "#src/features/apps/agent-app-access";
import { toAgentAccessMode } from "#src/features/apps/agent-access-scope";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type { InstallationAgentScopeStore } from "#src/server/app-agent-access/installation-agent-scope.server";
import { approvePendingRequest, SCOPE_SELECT } from "./app-agent-access.repositories.server";
import { findWorkspaceMemberRole } from "./workspace-member-role.repositories.server";

/** An installation's Agent access mode and selection rows; who may change them, and which
 * pending requests a change settles, stay in `server/app-agent-access/`. */
export class PrismaInstallationAgentScopeStore implements InstallationAgentScopeStore {
  constructor(private readonly db: PrismaClient) {}

  findMemberRole(workspaceId: string, userId: string) {
    return findWorkspaceMemberRole(this.db, workspaceId, userId);
  }

  async findScope(workspaceId: string, appKey: string) {
    const row = await this.db.appInstallation.findFirst({
      where: { workspaceId, app: { key: appKey } },
      select: { id: true, ...SCOPE_SELECT },
    });
    if (!row) return undefined;
    return {
      installationId: row.id,
      mode: toAgentAccessMode(row.agentAccess),
      agentIds: row.agents.map((agent) => agent.agentId),
    };
  }

  async listAgents(workspaceId: string) {
    const rows = await this.db.agent.findMany({
      where: { workspaceId, systemKind: null, workspaceMemoryAgent: null, ...ACTIVE_AGENT_WHERE },
      select: { id: true, displayName: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({ id: row.id, name: row.displayName }));
  }

  setScope(input: Parameters<InstallationAgentScopeStore["setScope"]>[0]) {
    return this.db.$transaction(async (tx) => {
      const installation = await tx.appInstallation.update({
        where: { id: input.installationId },
        data: { agentAccess: input.mode },
        select: { appId: true, workspaceId: true, app: { select: { allowedScopes: true } } },
      });
      await tx.appInstallationAgent.deleteMany({ where: { installationId: input.installationId } });
      await tx.appInstallationAgent.createMany({
        data: input.agentIds.map((agentId) => ({ installationId: input.installationId, agentId })),
      });
      const { appId, workspaceId } = installation;
      const waiting = await tx.appAgentAccessRequest.findMany({
        where: { appId, workspaceId, status: "pending", agent: ACTIVE_AGENT_WHERE },
        select: { id: true, agentId: true, scopes: true },
      });
      const grants = await tx.appAgentGrant.findMany({
        where: { appId, agentId: { in: waiting.map((request) => request.agentId) } },
        select: { agentId: true },
      });
      const granted = new Set(grants.map((grant) => grant.agentId));
      const settle = new Set(
        input.settle(
          waiting.map((r) => ({ id: r.id, agentId: r.agentId, hasGrant: granted.has(r.agentId) })),
        ),
      );
      const settled: string[] = [];
      for (const request of waiting.filter((r) => settle.has(r.id))) {
        const approved = await approvePendingRequest(tx, {
          requestId: request.id,
          agentId: request.agentId,
          userId: input.userId,
        });
        if (!approved) continue;
        await tx.appAgentGrant.create({
          data: {
            appId,
            agentId: request.agentId,
            workspaceId,
            scopes: allowedGrantScopes(request.scopes, installation.app.allowedScopes),
            source: "automatic",
            grantedByUserId: null,
          },
        });
        settled.push(request.id);
      }
      return settled;
    });
  }
}
