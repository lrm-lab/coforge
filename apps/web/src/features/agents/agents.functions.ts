import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
  agentIdInputSchema,
  agentIdSchema,
  changeAgentVisibilityInputSchema,
  createAgentInputSchema,
  deleteAgentInputSchema,
  saveAgentRuntimeCredentialInputSchema,
  saveAgentEnvironmentInputSchema,
  updateAgentInputSchema,
  updateAgentRoleInputSchema,
} from "./agent.schemas";
import { AGENT_VISIBILITY } from "./agent-visibility";
import {
  publishAgentDirectoryChanged,
  publishAgentVisibilityChanged,
} from "#src/server/agents/agent-visibility-realtime.server";
import { ChangeAgentVisibility } from "#src/server/agents/change-agent-visibility.server";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";
import { PrismaChangeAgentVisibilityStore } from "#src/server/db/repositories/agent-visibility-change.repositories.server";
import { setAgentRole } from "#src/server/agents/agent-role.server";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { listVisibleAgentModels } from "#src/server/agents/agent-models.server";
import { AgentAvatars, agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import { isAdminLike, type WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import { AgentDeletion } from "#src/server/agents/agent-deletion.server";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { userAgentRuntimeControl } from "#src/server/agents/user-agent-control.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { AgentDetailQuery } from "#src/server/agents/agent-detail.server";
import {
  agentVisibilityViewerForUser,
  assertAgentVisible,
  visiblePrivateAgentWhere,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { PrismaAgentRuntimeCredentialRepository } from "#src/server/db/repositories/agent-runtime-credential.repositories.server";
import {
  AgentRuntimeCredentials,
  readAgentRuntimeCredentialEncryptionKey,
} from "#src/server/agents/agent-runtime-credentials.server";
import { ChangeAgentRuntimeCredential } from "#src/server/agents/change-agent-runtime-credential.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import { computerCanRunAgent } from "#src/server/agents/computer-runtime-availability.server";
import { ensureWeeklyReportAssistant } from "#src/server/records/weekly-report-assistant.server";
import {
  parseAgentRuntimeConfig,
  publicAgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import { getAgentStatusCache } from "#src/server/agents/agent-status.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { AgentEnvironment } from "#src/server/agents/agent-environment.server";
import {
  issueAgentActivitySubscriptionToken,
  issueAgentActivitySubscriptionTokenForAgent,
  issueAgentStatusSubscriptionToken,
  issueAgentStatusSubscriptionTokenForAgent,
} from "#src/server/auth/browser-realtime-token.server";

type Database = ReturnType<typeof requireDatabaseClient>;

function manageAgents(db: Database) {
  const agents = new PrismaAgentRepository(db);
  const runtimeLock = getAgentRuntimeLock();
  const agentManagement = new ManageAgents(
    agents,
    {
      start: (intent, ownerId) => userAgentRuntimeControl(db, agents).start(intent, ownerId),
      stop: (intent, ownerId) => userAgentRuntimeControl(db, agents).stop(intent, ownerId),
    },
    {
      canRun: (workspaceId, userId, computerId, config) =>
        computerCanRunAgent(db, { workspaceId, userId }, computerId, config),
    },
    runtimeLock,
    () => runtimeCredentials(db, true),
    new AgentAvatars(db),
  );
  return agentManagement;
}

async function runtimeCredentials(db: Database, decrypt = false) {
  return new AgentRuntimeCredentials(
    new PrismaAgentRuntimeCredentialRepository(db),
    decrypt ? await readAgentRuntimeCredentialEncryptionKey(process.env) : undefined,
  );
}

async function changeRuntimeCredential(db: Database, decrypt = false) {
  const agents = new PrismaAgentRepository(db);
  return new ChangeAgentRuntimeCredential(
    agents,
    await runtimeCredentials(db, decrypt),
    userAgentRuntimeControl(db, agents),
    getAgentRuntimeLock(),
  );
}

async function agentEnvironment(db: Database) {
  const agents = new PrismaAgentRepository(db);
  return new AgentEnvironment(
    new PrismaAgentRuntimeCredentialRepository(db),
    agents,
    userAgentRuntimeControl(db, agents),
    getAgentRuntimeLock(),
    await readAgentRuntimeCredentialEncryptionKey(process.env),
  );
}

function agentDeletion(db: Database) {
  const agents = new PrismaAgentRepository(db);
  return new AgentDeletion(
    agents,
    new PrismaAgentDeletionStore(db),
    userAgentRuntimeControl(db, agents),
    getAgentRuntimeLock(),
  );
}

function changeAgentVisibilityUseCase(db: Database) {
  return new ChangeAgentVisibility(
    new PrismaAgentRepository(db),
    new PrismaChangeAgentVisibilityStore(db),
    publishAgentVisibilityChanged,
    new AgentInboxPurgePublisher(db),
  );
}

export const listAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const agents = await manageAgents(db).list({ userId: user.id, workspaceId });
    const statuses = getAgentStatusCache();
    // One round trip for every Agent's status lease, not one per Agent: the list is the page's
    // whole point and every row asks for the same kind of thing. Agents without a Computer have no
    // lease to read, so they are not asked for and stay `undefined` exactly as before.
    const scoped = agents.filter((agent) => agent.computerId);
    const scopes = scoped.map((agent) => ({
      workspaceId,
      computerId: agent.computerId as string,
      agentId: agent.id,
    }));
    // The display read model is script-backed and reads or projects each Agent's own state, so it
    // gets the same treatment: one round trip for the page. A display failure still never hides an
    // Agent profile — it leaves the rows without their display block, all of them together rather
    // than one at a time. The two reads touch different keys, so they go out together.
    const [statusSnapshots, displaySnapshots] = await Promise.all([
      statuses.snapshotMany(scopes),
      getAgentDisplay()
        .snapshotMany(scopes)
        .catch(() => []),
    ]);
    const statusByAgentId = new Map(
      scoped.map((agent, index) => [agent.id, statusSnapshots[index]] as const),
    );
    const displayByAgentId = new Map(
      scoped.map((agent, index) => [agent.id, displaySnapshots[index]] as const),
    );
    return agents.map((agent) => {
      const status = statusByAgentId.get(agent.id);
      const displaySnapshot = displayByAgentId.get(agent.id);
      return {
        ...agent,
        avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey ?? null),
        stopped: Boolean(agent.stoppedAt),
        ...(displaySnapshot ? { display: displaySnapshot } : {}),
        status: {
          value: status?.status ?? ("inactive" as const),
          expiresAt: status?.expiresAt ?? null,
          ordering: status
            ? {
                daemonInstanceId: status.daemonInstanceId,
                clientSeq: status.clientSeq,
                observedAtMs: status.observedAtMs,
              }
            : null,
        },
      };
    });
  });

/** Ensures the User's weekly-report assistant Agent exists for Members setup. */
export const ensureWeeklyReportAssistantMember = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const row = await ensureWeeklyReportAssistant(db, {
      workspaceId,
      userId: user.id,
    });
    return { agentId: row.agentId };
  });

export const getAgentStatusSubscriptionToken = createServerFn({
  method: "GET",
})
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueAgentStatusSubscriptionToken({ userId: user.id, workspaceId });
  });

export const getAgentActivitySubscriptionToken = createServerFn({
  method: "GET",
})
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueAgentActivitySubscriptionToken({ userId: user.id, workspaceId });
  });

/** The minimal row `assertAgentVisible` needs for the per-Agent subscription-token
 * endpoints below — never the full `AgentRecord`, and never cached. */
async function agentVisibilityRow(db: Database, agentId: string) {
  return db.agent.findUnique({
    where: { id: agentId },
    select: { workspaceId: true, ownerId: true, visibility: true },
  });
}

/**
 * A per-Agent realtime subscription token is only ever issued to a viewer who can
 * currently see that Agent — an unrecognized/missing Agent and an invisible one answer the same
 * `AGENT_NOT_VISIBLE`, so neither leaks which case applies.
 */
export const getAgentActivitySubscriptionTokenForAgent = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context }) => {
    const { user, workspaceId, db } = context;
    const agent = await agentVisibilityRow(db, data.agentId);
    if (!agent || agent.workspaceId !== workspaceId) throw new AppError("AGENT_NOT_VISIBLE");
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    assertAgentVisible(viewer, agent);
    return issueAgentActivitySubscriptionTokenForAgent({
      userId: user.id,
      workspaceId,
      agentId: data.agentId,
    });
  });

/** The per-Agent status-channel sibling of `getAgentActivitySubscriptionTokenForAgent`. */
export const getAgentStatusSubscriptionTokenForAgent = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context }) => {
    const { user, workspaceId, db } = context;
    const agent = await agentVisibilityRow(db, data.agentId);
    if (!agent || agent.workspaceId !== workspaceId) throw new AppError("AGENT_NOT_VISIBLE");
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    assertAgentVisible(viewer, agent);
    return issueAgentStatusSubscriptionTokenForAgent({
      userId: user.id,
      workspaceId,
      agentId: data.agentId,
    });
  });

/** The configured model of every Agent the viewer may see in the Workspace, by Agent id, for the
 * model shown beside an Agent's name in chat (Settings → Show agent model). */
export const listAgentModels = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, workspaceId, db } }) => {
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    return listVisibleAgentModels(db, workspaceId, viewer);
  });

/**
 * Realtime gap: the viewer's own `listAgents` roster (their owned Agents) is narrower
 * than what they are authorized to see — an owner/admin, or a private Agent's creator viewing it
 * from outside their own roster, can still see other private Agents. This returns exactly the
 * ids the browser needs to subscribe the matching per-Agent realtime channels for, never a full
 * row (the profile panel's own authorized fetch supplies details for any id it is given).
 */
export const listVisiblePrivateAgentIds = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, workspaceId, db } }) => {
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    const rows = await db.agent.findMany({
      where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...visiblePrivateAgentWhere(viewer) },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  });

export const createAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(createAgentInputSchema)
  .handler(async ({ data, context }) => {
    // The Workspace the page names, like every other Agent write.
    const { user, db, workspaceId } = context;
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    // An `agent:create` action card: guard it is still committable
    // *before* creating the Agent, then mark it `executed` *after* — `ManageAgents.create` below
    // enforces `assertCanCreateAgents` itself, so a plain member fails there and the card stays
    // `pending`; see `ActionCards`'s ordering comment in `action-cards.server.ts`.
    const centrifugo = createCentrifugoServerApi();
    const actionCards = new ActionCards(
      db,
      undefined,
      new CentrifugoConversationRealtime(centrifugo),
    );
    if (data.actionCardMessageId)
      await actionCards.assertAgentCreateCommittable(
        workspaceId,
        user.id,
        data.actionCardMessageId,
        data.computerId,
      );
    const created = await manageAgents(db).create({ userId: user.id, workspaceId, role }, data);
    try {
      await publishAgentDirectoryChanged(workspaceId, created.agent.id, "created");
    } catch {
      // The Agent is already committed; a missed directory signal is repaired by reconnect/focus.
    }
    if (data.actionCardMessageId)
      await actionCards.completeAgentCreate(
        workspaceId,
        user.id,
        data.actionCardMessageId,
        created.agent.id,
      );
    return created;
  });

export const updateAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(updateAgentInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const assistant = await db.weeklyReportAssistant.findFirst({
      where: { agentId: data.agentId, workspaceId, userId: user.id },
      select: { agentId: true },
    });
    const updated = await manageAgents(db).update(
      { userId: user.id, workspaceId },
      // The weekly-report assistant's display label (「李健的周报助手」) is server-owned; drop any
      // client-supplied value so `ManageAgents.update` falls back to the existing displayName.
      // Its username (`name`) is fixed at creation and is never part of an update.
      assistant ? { ...data, displayName: undefined } : data,
    );
    try {
      await publishAgentDirectoryChanged(workspaceId, updated.agent.id, "updated");
    } catch {
      // The Agent is already committed; a missed directory signal is repaired by reconnect/focus.
    }
    return updated;
  });

/** Lets a Workspace owner/admin grant or revoke an Agent's own management (channel admin)
 * authority; never assigns `"owner"` (see `setAgentRole`). */
export const updateAgentRole = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(updateAgentRoleInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const result = await setAgentRole(db, {
      workspaceId,
      actorUserId: user.id,
      agentId: data.agentId,
      role: data.role,
    });
    try {
      await publishAgentDirectoryChanged(workspaceId, result.agentId, "updated");
    } catch {
      // The role write is already committed; a missed directory signal is repaired by reconnect/focus.
    }
    return result;
  });

/**
 * Changes one Agent's visibility: the creator or a human Workspace owner/admin only.
 * `ChangeAgentVisibility.execute` authorizes and runs the transition; the shared
 * `AppError`→HTTP mapping surfaces `NOT_FOUND`/`ACCESS_DENIED` to the profile panel's inline
 * error the same way every other Agent mutation does.
 */
export const changeAgentVisibility = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(changeAgentVisibilityInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    return changeAgentVisibilityUseCase(db).execute(
      { userId: user.id, workspaceId, role },
      { agentId: data.agentId, visibility: data.visibility },
    );
  });

/**
 * The public→private confirmation dialog's preview: channels the Agent will leave and how many
 * existing direct conversations will become read-only. Only someone who may change the Agent's
 * visibility gets it.
 */
export const previewAgentVisibilityChange = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context: { user, db, workspaceId } }) => {
    setResponseHeader("cache-control", "no-store");
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    return changeAgentVisibilityUseCase(db).preview(
      { userId: user.id, workspaceId, role },
      agentId,
    );
  });

/**
 * Backs `getAgentProfile`, the one seam the Members page and every conversation panel share:
 * identity, permissions, live display and runtime config summary. Activity history is not part
 * of it: the Activity tab reads its own feed (`getAgentActivityFeed`). Does not run
 * `listComputers`/`getUserPreferences` — those stay owned by the route loaders that actually need
 * a Computer picker or a User's time zone preference.
 */
async function loadAgentProfileDetail(context: WorkspaceUserContext, agentId: string) {
  const { user, db, workspaceId } = context;
  // Fetched once, ahead of `AgentDetailQuery` so `findAuthorized`'s visibility gate
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
    {
      findAuthorized: async (workspaceId, id, userId) => {
        const agent = await db.agent.findFirst({
          where: {
            id,
            workspaceId,
            workspace: { members: { some: { userId } } },
            // A deleted Agent has no profile to open; its history stays readable
            // through the conversation views instead.
            ...ACTIVE_AGENT_WHERE,
          },
          select: {
            id: true,
            workspaceId: true,
            name: true,
            displayName: true,
            description: true,
            role: true,
            visibility: true,
            createdAt: true,
            computerId: true,
            computer: {
              select: {
                id: true,
                name: true,
                displayName: true,
                kind: true,
                computerVersion: true,
              },
            },
            runtimeConfig: true,
            stoppedAt: true,
            weeklyReportAssistant: { select: { id: true } },
            owner: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarObjectKey: true,
              },
            },
            avatarObjectKey: true,
          },
        });
        if (!agent) return undefined;
        // An existing-but-invisible Agent answers a stable "not visible" result, never
        // its details — distinct from the plain absence above so the profile panel can render
        // the specific "not visible" copy instead of a generic "not found".
        assertAgentVisible(viewer, { visibility: agent.visibility, ownerId: agent.owner.id });
        return agent;
      },
    },
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
  const canFullResetAgent = canManageAgentRole;
  // `deleteAgents` is owner/admin only, the same gate as `createAgents`. The
  // weekly-report assistant is provisioned by Records on demand, so it is never a delete target
  // even for an owner/admin viewer. Server-side authorization lives in `AgentDeletion.delete()`.
  const canDeleteAgent = canManageAgentRole && !result.isWeeklyReportAssistant;
  // The creator or a human Workspace owner/admin may change visibility; never an Agent
  // (this seam is always reached by a human viewer) and never a plain member acting on someone
  // else's Agent.
  const canChangeVisibility = ownedByCurrentUser || canManageAgentRole;
  // Best-effort: the Agent profile panel's Computer meta line ("Connected · v0.1.0-dev.35"). Redis
  // unavailability degrades to "unknown" (`undefined`), never a false "offline".
  const computerOnline = result.computer
    ? await getComputerStatusCache()
        .get({ workspaceId, computerId: result.computer.id })
        .catch(() => undefined)
    : undefined;
  const runtimeConfig = parseAgentRuntimeConfig(result.runtimeConfig);
  // Same rule `scanUsage`/`readUsage` enforce (`computers.functions.ts`): the Runtime badge only
  // offers the usage popover when a scan against this Computer's runtime would actually be
  // honoured, so the Profile tab never renders a control the server would refuse. One lookup
  // (`ownedRuntime`) answers both that gate and the CLI `version` its popover header shows.
  const ownedRuntime = result.computer
    ? await new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db)).ownedRuntime(
        { workspaceId, userId: user.id },
        result.computer.id,
        runtimeConfig.runtime,
      )
    : undefined;
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
    avatarUrl: agentAvatarUrl(workspaceId, result.id, result.avatarObjectKey ?? null),
    runtimeConfig: publicAgentRuntimeConfig(runtimeConfig),
    ownedByCurrentUser,
    runtimeCredential,
    canManageAgentRole,
    canFullResetAgent,
    canDeleteAgent,
    // Fails closed the same way `canSeeAgent`/`visibleAgentWhere` do: anything but exactly
    // `"public"` displays as private, since that is also how the authorization seam treats it.
    visibility:
      result.visibility === AGENT_VISIBILITY.PUBLIC
        ? AGENT_VISIBILITY.PUBLIC
        : AGENT_VISIBILITY.PRIVATE,
    canChangeVisibility,
    runtimeUsageVisible: Boolean(ownedRuntime),
    runtimeVersion: ownedRuntime?.version,
    // Always the same shape (`online` present, possibly `undefined`) whether or not a Computer is
    // assigned, so callers never have to narrow a union between "has computer without online" and
    // "has computer with online".
    computer: result.computer ? { ...result.computer, online: computerOnline } : undefined,
  };
}

/** The Agent profile panel's data seam (see `features/agents/profile-panel/`): the Members
 * directory and every conversation panel share this one query. */
const avatarFileSchema = z.custom<File>(
  (value) => typeof File !== "undefined" && value instanceof File,
);

/** The creator replaces this Agent's picture. Bytes stay in the image store; the row keeps the key. */
export const uploadAgentAvatar = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((data: unknown) => {
    if (!(data instanceof FormData)) throw new AppError("INVALID_INPUT");
    const agentId = agentIdSchema.safeParse(data.get("agentId"));
    const file = avatarFileSchema.safeParse(data.get("file"));
    if (!agentId.success || !file.success) throw new AppError("INVALID_INPUT");
    return { agentId: agentId.data, file: file.data };
  })
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const result = await new AgentAvatars(db).store(workspaceId, user.id, data.agentId, data.file);
    try {
      await publishAgentDirectoryChanged(workspaceId, data.agentId, "updated");
    } catch {
      // The avatar write is already committed; a missed directory signal is repaired by reconnect/focus.
    }
    return result;
  });

/** The creator gives this Agent one of the platform's pictures, stored as its own copy. */
export const chooseAgentAvatarPicture = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ agentId: agentIdSchema, pictureId: z.string().max(32) }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const result = await new AgentAvatars(db).storeChosen(
      workspaceId,
      user.id,
      data.agentId,
      data.pictureId,
    );
    try {
      await publishAgentDirectoryChanged(workspaceId, data.agentId, "updated");
    } catch {
      // The avatar write is already committed; a missed directory signal is repaired by reconnect/focus.
    }
    return result;
  });

export const removeAgentAvatar = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    await new AgentAvatars(db).remove(workspaceId, user.id, data.agentId);
    try {
      await publishAgentDirectoryChanged(workspaceId, data.agentId, "updated");
    } catch {
      // The avatar write is already committed; a missed directory signal is repaired by reconnect/focus.
    }
  });

export const getAgentProfile = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const result = await loadAgentProfileDetail(context, agentId);
    if (!result) throw new Error("Agent not found");
    setResponseHeader("cache-control", "no-store");
    return result;
  });

export const saveAgentRuntimeCredential = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(saveAgentRuntimeCredentialInputSchema)
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    return (await changeRuntimeCredential(db, true)).save(
      { workspaceId, userId: user.id },
      data.agentId,
      data.apiKey,
    );
  });

export const deleteAgentRuntimeCredential = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const { user, db, workspaceId } = context;
    return (await changeRuntimeCredential(db)).delete({ workspaceId, userId: user.id }, agentId);
  });

/**
 * Deletes an Agent: the `deleteAgents` capability, Workspace owner/admin only. The
 * typed name is re-checked against the Agent's current `name` here, inside the same call that
 * performs the delete, so a concurrent rename cannot bypass confirmation — the same guard
 * `ProjectSettings.delete` uses. Deleting the Agent's own runtime credential is a separate
 * concern; `AgentDeletion` revokes Agent API keys and cancels Reminders itself.
 */
export const deleteAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(deleteAgentInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const agent = await db.agent.findFirst({
      where: { id: data.agentId, workspaceId },
      select: { name: true },
    });
    if (!agent || agent.name !== data.confirmation) throw new AppError("INVALID_INPUT");
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    const result = await agentDeletion(db).delete(
      { userId: user.id, workspaceId, role },
      data.agentId,
    );
    // A protected Agent is not a delete target at all; the dialog shows its own message for this
    // rather than the generic failure, so surface it as a distinguishable error.
    if (result.outcome === "protected")
      throw new AppError("CONFLICT", { errorId: "agent-delete-protected" });
    if (result.outcome === "deleted") {
      try {
        await publishAgentDirectoryChanged(workspaceId, data.agentId, "deleted");
      } catch {
        // The Agent is already committed; a missed directory signal is repaired by reconnect/focus.
      }
    }
    return result;
  });

export const getAgentEnvironment = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const { user, db, workspaceId } = context;
    setResponseHeader("cache-control", "no-store");
    return (await agentEnvironment(db)).get({ workspaceId, userId: user.id }, agentId);
  });

export const saveAgentEnvironment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(saveAgentEnvironmentInputSchema)
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    return (await agentEnvironment(db)).save(
      { workspaceId, userId: user.id },
      data.agentId,
      data.envVars,
    );
  });
