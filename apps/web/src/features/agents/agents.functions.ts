import {
  manageAgents,
  runtimeCredentials,
} from "#src/server/agents/manage-agents-production.server";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
  agentIdSchema,
  changeAgentVisibilityInputSchema,
  createAgentInputSchema,
  deleteAgentInputSchema,
  saveAgentRuntimeCredentialInputSchema,
  saveAgentEnvironmentInputSchema,
  updateAgentInputSchema,
  updateAgentRoleInputSchema,
} from "./agent.schemas";
import { publishAgentDirectoryChanged } from "#src/server/agents/agent-visibility-realtime.server";
import { setAgentRole } from "#src/server/agents/agent-role.server";
import { AppError, isAppErrorCode } from "#src/lib/app-error";
import { listVisibleAgentModels } from "#src/server/agents/agent-models.server";
import { AGENT_MASCOTS } from "#src/features/agents/agent-mascot";
import { AgentMascots } from "#src/server/agents/agent-mascot.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { listArchivedAgents } from "#src/server/agents/archived-agents.server";
import { userAgentRuntimeControl } from "#src/server/agents/user-agent-control.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { agentVisibilityViewerForUser } from "#src/server/agents/agent-visibility.server";
import { agentDeletion, changeAgentVisibilityUseCase } from "./agents-lifecycle.functions";
import { loadAgentProfileDetail } from "./agent-profile-detail.server";
import { PrismaAgentRuntimeCredentialRepository } from "#src/server/db/repositories/agent-runtime-credential.repositories.server";
import { readAgentRuntimeCredentialEncryptionKey } from "#src/server/agents/agent-runtime-credentials.server";
import { ChangeAgentRuntimeCredential } from "#src/server/agents/change-agent-runtime-credential.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import {
  ensureWeeklyReportAssistant,
  userOwnsLiveComputer,
} from "#src/server/records/weekly-report-assistant.server";

import { readAgentRoster } from "#src/server/agents/agent-roster.server";
import { AgentEnvironment } from "#src/server/agents/agent-environment.server";

type Database = ReturnType<typeof requireDatabaseClient>;

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

export const listAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) =>
    readAgentRoster(db, user.id, workspaceId),
  );

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

/** The configured model of every Agent the viewer may see in the Workspace, by Agent id, for the
 * model shown beside an Agent's name in chat (Settings → Show agent model). */
export const listAgentModels = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, workspaceId, db } }) => {
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    return listVisibleAgentModels(db, workspaceId, viewer);
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
    if (
      assistant &&
      data.computerId &&
      !(await userOwnsLiveComputer(db, { userId: user.id, computerId: data.computerId }))
    )
      throw new AppError("ACCESS_DENIED");
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

const setAgentMascotInput = z.object({ agentId: agentIdSchema, mascot: z.enum(AGENT_MASCOTS) });

/** The creator picks which platform mascot this Agent shows. */
export const setAgentMascot = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(setAgentMascotInput)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const result = await new AgentMascots(db).set(workspaceId, user.id, data.agentId, data.mascot);
    try {
      await publishAgentDirectoryChanged(workspaceId, data.agentId, "updated");
    } catch {
      // The mascot write is already committed; a missed directory signal is repaired by reconnect/focus.
    }
    return result;
  });

/** The Agent profile panel's data seam (see `features/agents/profile-panel/`): the Members
 * directory and every conversation panel share this one query. */
export const getAgentProfile = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const result = await loadAgentProfileDetail(context, agentId);
    if (!result) throw new Error("Agent not found");
    setResponseHeader("cache-control", "no-store");
    return result;
  });

/** The Workspace's archived Agents for Settings → Workspace profile, newest archive first;
 * `null` for anyone but a Workspace owner or admin. */
export const loadArchivedAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    try {
      return await listArchivedAgents(db, workspaceId, user.id);
    } catch (error) {
      if (isAppErrorCode(error, "ACCESS_DENIED")) return null;
      throw error;
    }
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
