import { createServerFn } from "@tanstack/react-start";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  encodeAgentWorkspaceFileReadRequest,
  encodeAgentWorkspaceFilesListRequest,
  encodeAgentWorkspaceDeleteRequest,
} from "@lrm/coforge-sdk/internal";
import {
  agentIdInputSchema,
  listAgentWorkspaceFilesInputSchema,
  readAgentWorkspaceFileInputSchema,
} from "./agent.schemas";
import { archivedAgentWorkspaceFilesQuery } from "#src/server/computers/computer-workspace-files.server";
import { scanComputerAgentWorkspaces } from "#src/server/computers/computer-agent-workspaces.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  AgentWorkspaceFilesQuery,
  findOwnedWorkspaceFilesAssignment,
} from "#src/server/agents/agent-workspace-files.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  getAgentWorkspaceFileReadResults,
  getAgentWorkspaceFilesListResults,
  getAgentWorkspaceDeleteResults,
} from "#src/server/centrifugo/agent-workspace-files-cache.server";

function buildQuery(db: Parameters<typeof findOwnedWorkspaceFilesAssignment>[0]) {
  return new AgentWorkspaceFilesQuery({
    findOwned: (viewer, id) => findOwnedWorkspaceFilesAssignment(db, viewer, id),
    online: (scope) => getComputerStatusCache().get(scope),
    publishList: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentWorkspaceFilesListRequest(request),
      ),
    publishRead: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentWorkspaceFileReadRequest(request),
      ),
    listResults: getAgentWorkspaceFilesListResults(),
    readResults: getAgentWorkspaceFileReadResults(),
    publishDelete: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentWorkspaceDeleteRequest(request),
      ),
    deleteResults: getAgentWorkspaceDeleteResults(),
  });
}

export const listAgentWorkspaceFiles = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(listAgentWorkspaceFilesInputSchema)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const { user, db, workspaceId } = context;
    return buildQuery(db).list(
      { userId: user.id, workspaceId },
      data.agentId,
      data.dirPath,
      data.includeHidden,
    );
  });

export const readAgentWorkspaceFile = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(readAgentWorkspaceFileInputSchema)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const { user, db, workspaceId } = context;
    return buildQuery(db).read({ userId: user.id, workspaceId }, data.agentId, data.path);
  });

/**
 * An archived Agent's workspace as its Computer reports it now, for its profile's ARCHIVE
 * section. The Computer's owner or a Workspace owner/admin may read it
 * (`archivedAgentWorkspaceAssignment`); anyone else gets `null`.
 */
export const scanArchivedAgentWorkspace = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    const viewer = { userId: user.id, workspaceId };
    const query = archivedAgentWorkspaceFilesQuery(
      db,
      await workspaceMemberRole(db, workspaceId, user.id),
      { list: true },
    );
    const agent = await db.agent.findFirst({
      where: { id: data.agentId, workspaceId, deletedAt: { not: null } },
      select: { id: true, name: true, displayName: true, deletedAt: true },
    });
    if (!agent) return null;
    const [workspace] = await scanComputerAgentWorkspaces([agent], async (request) => {
      const response = await query.list(
        viewer,
        request.agentId,
        request.dirPath,
        request.includeHidden,
      );
      if (response.status !== "ready")
        return {
          status: response.status === "offline" ? "unreadable" : "error",
          rootPath: "",
          entries: [],
        };
      return response.result;
    });
    return workspace ?? null;
  });

/** Deletes an archived Agent's workspace from its Computer, for the same viewers. */
export const deleteArchivedAgentWorkspace = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    const query = archivedAgentWorkspaceFilesQuery(
      db,
      await workspaceMemberRole(db, workspaceId, user.id),
      { list: false },
    );
    const response = await query.delete({ userId: user.id, workspaceId }, data.agentId);
    if (response.status !== "ready") return response;
    return response.result;
  });
