import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import { AgentDetailQuery } from "#src/server/agents/agent-detail.server";
import { PrismaAgentDetailSource } from "#src/server/db/repositories/agent-detail.repositories.server";
import { type AgentVisibilityViewer } from "#src/server/agents/agent-visibility.server";
import { getAgentStatusCache } from "#src/server/agents/agent-status.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { runtimeCredentials } from "#src/server/agents/manage-agents-production.server";
import {
  publicAgentRuntimeConfig,
  readableRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { PrismaExternalAgentCredentialRepository } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import {
  agentDisplayScope,
  externalSetups,
} from "#src/server/agents/external-agent-presence.server";
import { userRuntimeUsage } from "#src/server/computers/runtime-usage-composition.server";
import { isAdminLike, type WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";
import { agentAvatarUrl, agentMascot } from "#src/features/agents/agent-mascot";
import { humanLabel } from "#src/lib/human-label";
import { normalizeAgentVisibility } from "./agent-visibility";

export async function loadAgentProfileDetail(context: WorkspaceUserContext, agentId: string) {
  const { user, db, workspaceId } = context;
  const viewerMembership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    select: { role: true },
  });
  const viewer: AgentVisibilityViewer = {
    kind: "user",
    userId: user.id,
    role: viewerMembership?.role,
  };
  const query = new AgentDetailQuery(
    new PrismaAgentDetailSource(db, viewer),
    {
      snapshot: (scope) => getAgentStatusCache().snapshot(scope),
    },
    {
      snapshot: (scope) => getAgentDisplay().snapshot(scope),
    },
  );
  const result = await query.get(workspaceId, agentId, user.id);
  if (!result) return undefined;
  const ownedByCurrentUser = result.owner.id === user.id;
  const live = !result.deletedAt;
  const runtimeCredential = ownedByCurrentUser
    ? await (await runtimeCredentials(db)).summary({ workspaceId, userId: user.id }, agentId)
    : null;
  const canManageAgentRole = viewerMembership
    ? isAdminLike(viewerMembership.role as WorkspaceMemberRole)
    : false;
  const canFullResetAgent = canManageAgentRole && live;
  const canDeleteAgent = canManageAgentRole && live && !result.isWeeklyReportAssistant;
  const canChangeVisibility = live && (ownedByCurrentUser || canManageAgentRole);
  const runtimeConfig = readableRuntimeConfig(result.runtimeConfig);
  const { computer } = result;
  const externalDisplayScope =
    result.hosting === "external" ? agentDisplayScope(workspaceId, result) : undefined;
  const [computerOnline, usage, externalCredentials, workspace, externalSetup, externalDisplay] =
    await Promise.all([
      computer
        ? getComputerStatusCache()
            .get({ workspaceId, computerId: computer.id })
            .catch(() => undefined)
        : undefined,
      computer && runtimeConfig
        ? userRuntimeUsage(db).usageOffer(
            { userId: user.id, workspaceId },
            { computerId: computer.id, provider: runtimeConfig.runtime },
          )
        : undefined,
      result.hosting === "external" && (ownedByCurrentUser || canManageAgentRole)
        ? new PrismaExternalAgentCredentialRepository(db)
            .list(agentId)
            .then((rows) => rows.filter((row) => !row.revokedAt))
        : undefined,
      result.hosting === "external"
        ? db.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } })
        : undefined,
      result.hosting === "external"
        ? externalSetups(new PrismaExternalAgentCredentialRepository(db), [agentId]).then(
            (setups) => setups.get(agentId),
          )
        : undefined,
      externalDisplayScope
        ? getAgentDisplay()
            .snapshot(externalDisplayScope)
            .catch(() => undefined)
        : undefined,
    ]);
  return {
    ...result,
    owner: {
      ...result.owner,
      avatarUrl: workspaceUserAvatarUrl(
        workspaceId,
        result.owner.id,
        result.owner.avatarObjectKey ?? null,
      ),
    },
    mascot: agentMascot(result.id, result.avatarMascot),
    avatarUrl: result.appBot?.logoUrl ?? agentAvatarUrl(result.id, result.avatarMascot ?? null),
    runtimeConfig: publicAgentRuntimeConfig(runtimeConfig),
    runtimeConfigInvalid: result.runtimeConfig != null && !runtimeConfig,
    ownedByCurrentUser,
    runtimeCredential,
    canManageAgentRole,
    canFullResetAgent,
    canDeleteAgent,
    visibility: normalizeAgentVisibility(result.visibility),
    canChangeVisibility,
    runtimeUsageVisible: usage?.offered ?? false,
    runtimeVersion: usage?.runtime?.version,
    ...(externalDisplay ? { display: externalDisplay } : {}),
    externalCredentials: externalCredentials ?? [],
    externalSetup: externalSetup ?? null,
    workspaceSlug: workspace?.slug ?? null,
    computer: result.computer
      ? {
          ...result.computer,
          online: computerOnline,
          ownedByViewer: result.computer.ownerId === user.id,
        }
      : undefined,
    deletedBy: result.deletedBy
      ? {
          id: result.deletedBy.id,
          label: humanLabel(result.deletedBy),
          avatarUrl: workspaceUserAvatarUrl(
            workspaceId,
            result.deletedBy.id,
            result.deletedBy.avatarObjectKey ?? null,
          ),
        }
      : null,
  };
}
