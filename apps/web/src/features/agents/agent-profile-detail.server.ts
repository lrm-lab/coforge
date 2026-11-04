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
import { loadAgentOwnedRuntime } from "#src/server/computers/computer-runtime-visibility.server";
import { isAdminLike, type WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";
import { agentAvatarUrl, agentMascot } from "#src/features/agents/agent-mascot";
import { humanLabel } from "#src/lib/human-label";
import { normalizeAgentVisibility } from "./agent-visibility";

export /**
 * Backs `getAgentProfile`, the one seam the Members page and every conversation panel share:
 * identity, permissions, live display and runtime config summary. Activity history is not part
 * of it: the Activity tab reads its own feed (`getAgentActivityFeed`). Does not run
 * `listComputers`/`getUserPreferences` — those stay owned by the route loaders that actually need
 * a Computer picker or a User's time zone preference.
 */
async function loadAgentProfileDetail(context: WorkspaceUserContext, agentId: string) {
  const { user, db, workspaceId } = context;
  // Fetched once, ahead of `AgentDetailQuery` so the source's visibility gate
  // and `canManageAgentRole` below share this single membership lookup.
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
  // A deleted Agent's profile is read-only: nothing on it acts on the Agent any more.
  const live = !result.deletedAt;
  const runtimeCredential = ownedByCurrentUser
    ? await (await runtimeCredentials(db)).summary({ workspaceId, userId: user.id }, agentId)
    : null;
  const canManageAgentRole = viewerMembership
    ? isAdminLike(viewerMembership.role as WorkspaceMemberRole)
    : false;
  // `findAuthorized` above already required current Workspace membership, so every viewer who
  // reaches this point holds the `controlAgentRuntime` capability (Restart/Reset session);
  // `resetAgentWorkspace` (Full reset) is owner/admin only, same role check as agent-role
  // management. Server-side authorization lives in AgentControl.execute(); this is UI gating.
  const canFullResetAgent = canManageAgentRole && live;
  // `deleteAgents` is owner/admin only, the same gate as `createAgents`. The
  // weekly-report assistant is provisioned by Records on demand, so it is never a delete target
  // even for an owner/admin viewer. Server-side authorization lives in `AgentDeletion.delete()`.
  const canDeleteAgent = canManageAgentRole && live && !result.isWeeklyReportAssistant;
  // The creator or a human Workspace owner/admin may change visibility; never an Agent
  // (this seam is always reached by a human viewer) and never a plain member acting on someone
  // else's Agent.
  const canChangeVisibility = live && (ownedByCurrentUser || canManageAgentRole);
  // Best-effort: the Agent profile panel's Computer meta line ("Connected · v0.1.0-dev.35"). Redis
  // unavailability degrades to "unknown" (`undefined`), never a false "offline".
  const computerOnline = result.computer
    ? await getComputerStatusCache()
        .get({ workspaceId, computerId: result.computer.id })
        .catch(() => undefined)
    : undefined;
  const runtimeConfig = readableRuntimeConfig(result.runtimeConfig);
  const ownedRuntime = await loadAgentOwnedRuntime(db, workspaceId, user.id, result, runtimeConfig);
  return {
    ...result,
    // The Creator row renders the same identity the rest of the product does (avatar image +
    // display name), so the owner's avatar URL is resolved here like every other person surface.
    owner: {
      ...result.owner,
      avatarUrl: workspaceUserAvatarUrl(
        workspaceId,
        result.owner.id,
        result.owner.avatarObjectKey ?? null,
      ),
    },
    mascot: agentMascot(result.id, result.avatarMascot),
    avatarUrl: agentAvatarUrl(result.id, result.avatarMascot ?? null),
    runtimeConfig: publicAgentRuntimeConfig(runtimeConfig),
    // A stored config the read could not parse: the Agent's owner re-selects its runtime
    // rather than seeing an empty section (task #517).
    runtimeConfigInvalid: result.runtimeConfig != null && !runtimeConfig,
    ownedByCurrentUser,
    runtimeCredential,
    canManageAgentRole,
    canFullResetAgent,
    canDeleteAgent,
    // Fails closed the same way `canSeeAgent`/`visibleAgentWhere` do: anything but exactly
    // `"public"` displays as private, since that is also how the authorization seam treats it.
    visibility: normalizeAgentVisibility(result.visibility),
    canChangeVisibility,
    runtimeUsageVisible: Boolean(ownedRuntime),
    runtimeVersion: ownedRuntime?.version,
    // Always the same shape (`online` present, possibly `undefined`) whether or not a Computer is
    // assigned, so callers never have to narrow a union between "has computer without online" and
    // "has computer with online".
    computer: result.computer
      ? {
          ...result.computer,
          online: computerOnline,
          // Only the Computer's owner may scan or delete the Agent's workspace on it.
          ownedByViewer: result.computer.ownerId === user.id,
        }
      : undefined,
    // Who archived it, labelled the way the rest of the product names a person; absent when
    // that was not recorded.
    deletedBy: result.deletedBy
      ? {
          id: result.deletedBy.id,
          label: humanLabel(result.deletedBy),
          // The face drawn beside the name (task #521).
          avatarUrl: workspaceUserAvatarUrl(
            workspaceId,
            result.deletedBy.id,
            result.deletedBy.avatarObjectKey ?? null,
          ),
        }
      : null,
  };
}
