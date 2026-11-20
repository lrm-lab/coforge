import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import { AgentDetailQuery } from "#src/server/agents/agent-detail.server";
import { PrismaAgentDetailSource } from "#src/server/db/repositories/agent-detail.repositories.server";
import {
  canDirectMessageAgent,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";
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
import { humanRef } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import {
  agentDisplayScope,
  externalSetups,
} from "#src/server/agents/external-agent-presence.server";
import { userRuntimeUsage } from "#src/server/computers/runtime-usage-composition.server";
import {
  agentReadinessOf,
  readAgentReadinessInputs,
} from "#src/server/agents/agent-readiness-facts.server";
import {
  computerRuntimeRefusal,
  storedRuntimeSelection,
} from "#src/server/agents/computer-runtime-availability.server";
import { agentReadinessPermissions } from "#src/server/agents/agent-readiness-permissions.server";
import { getComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
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
  const managesExternal =
    result.hosting === "external" && (ownedByCurrentUser || canManageAgentRole);
  const readinessReads = readAgentReadinessInputs(
    {
      latestUpgrade: async (computerId) =>
        (await getComputerUpgradeStore().latestMany([{ workspaceId, computerId }]))[0],
      runtimeRefusal: (computerId, selection) =>
        computerRuntimeRefusal(db, { workspaceId, userId: user.id }, computerId, selection, {
          requireModel: false,
        }),
    },
    {
      computerId: computer?.id,
      selection: runtimeConfig ? storedRuntimeSelection(runtimeConfig) : undefined,
    },
  );
  const [
    computerOnline,
    usage,
    externalCredentials,
    workspace,
    externalSetup,
    externalDisplay,
    externalConnectTarget,
    computerAccessRevoked,
  ] = await Promise.all([
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
    managesExternal
      ? new PrismaExternalAgentCredentialRepository(db)
          .list(agentId)
          .then((rows) => rows.filter((row) => !row.revokedAt))
      : undefined,
    result.hosting === "external"
      ? db.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } })
      : undefined,
    result.hosting === "external"
      ? externalSetups(new PrismaExternalAgentCredentialRepository(db), [agentId]).then((setups) =>
          setups.get(agentId),
        )
      : undefined,
    externalDisplayScope
      ? getAgentDisplay()
          .snapshot(externalDisplayScope)
          .catch(() => undefined)
      : undefined,
    managesExternal &&
    canDirectMessageAgent(user.id, {
      visibility: normalizeAgentVisibility(result.visibility),
      ownerId: result.owner.id,
    })
      ? humanRef(db, workspaceId, agentId, user.username)
      : null,
    result.computerId
      ? db.workspaceComputer
          .findUnique({
            where: {
              workspaceId_computerId: { workspaceId, computerId: result.computerId },
            },
            select: { id: true },
          })
          .then((link) => !link)
      : false,
  ]);
  const readiness = agentReadinessOf(await readinessReads, {
    nowMs: Date.now(),
    computerId: computer?.id,
    computerOnline,
    stopReason: result.display?.stopReason ?? null,
    failureReason: result.failureReason,
  });
  const { runtimeConfigRevision, ...profile } = result;
  const codexUsage = runtimeConfig?.runtime === RUNTIME_PROVIDER.CODEX;
  const runtimeUsageVisible =
    !!usage?.offered &&
    (!codexUsage || (ownedByCurrentUser && live && result.hosting === "managed"));
  const { canManageRuntimeLogin, canControlAgentRuntime } = await agentReadinessPermissions(db, {
    userId: user.id,
    workspaceId,
    memberRole: viewerMembership?.role,
    computerId: computer?.id,
    provider: runtimeConfig?.runtime,
    readiness,
  });
  return {
    ...profile,
    readiness,
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
    canManageRuntimeLogin,
    canControlAgentRuntime,
    canFullResetAgent,
    canDeleteAgent,
    visibility: normalizeAgentVisibility(result.visibility),
    canChangeVisibility,
    runtimeUsageVisible,
    ...(codexUsage &&
      runtimeUsageVisible && {
        runtimeUsageRevision: runtimeConfigRevision ?? 0,
      }),
    runtimeVersion: usage?.runtime?.version,
    ...(externalDisplay ? { display: externalDisplay } : {}),
    externalCredentials: externalCredentials ?? [],
    externalSetup: externalSetup ?? null,
    externalConnectTarget: externalConnectTarget ?? null,
    workspaceSlug: workspace?.slug ?? null,
    computerAccessRevoked,
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
