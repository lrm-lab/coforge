import {
  encodeAgentWorkspaceDeleteRequest,
  encodeAgentWorkspaceFilesListRequest,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  AgentWorkspaceFilesQuery,
  type WorkspaceFilesAssignment,
  type WorkspaceFilesViewer,
} from "#src/server/agents/agent-workspace-files.server";
import {
  getAgentWorkspaceDeleteResults,
  getAgentWorkspaceFilesListResults,
} from "#src/server/centrifugo/agent-workspace-files-cache.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { isAdminLike, isWorkspaceMemberRole } from "#src/server/workspaces/member-role.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";

type Db = Pick<PrismaClient, "computer" | "agent">;

/** The Computer `computerId` names, if the viewer owns it and it serves this Workspace; otherwise
 * "Computer is not available". The Computer page's workspace scan and workspace delete both start
 * here. */
export async function findOwnedWorkspaceComputer(
  db: Pick<Db, "computer">,
  scope: { userId: string; workspaceId: string; computerId: string },
) {
  const computer = await db.computer.findFirst({
    where: {
      id: scope.computerId,
      ownerId: scope.userId,
      workspaces: { some: { workspaceId: scope.workspaceId } },
    },
    select: { id: true },
  });
  if (!computer) throw new Error("Computer is not available");
  return computer;
}

/** An Agent on this Computer whose workspace the viewer may scan or delete: the viewer owns the
 * Computer and it serves the viewer's Workspace. Deleted Agents stay eligible, so their retained
 * workspaces can still be cleaned up. The revision is the Agent's runtime configuration hash. */
export async function ownedComputerAgentAssignment(
  db: Pick<Db, "agent">,
  computerId: string,
  viewer: WorkspaceFilesViewer,
  agentId: string,
): Promise<WorkspaceFilesAssignment | undefined> {
  const assignment = await db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId: viewer.workspaceId,
      computerId,
      computer: {
        ownerId: viewer.userId,
        workspaces: { some: { workspaceId: viewer.workspaceId } },
      },
    },
    select: { computerId: true, runtimeConfig: true },
  });
  if (!assignment?.computerId) return undefined;
  return {
    computerId: assignment.computerId,
    revision: workspaceRevision(assignment.runtimeConfig),
  };
}

/** The revision a workspace request is bound to: the Agent's runtime configuration hash. */
function workspaceRevision(runtimeConfig: unknown) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(runtimeConfig)).digest("hex");
}

/**
 * An archived Agent whose workspace the viewer may scan or delete from its profile: the
 * Computer's owner, as on the Computer page, or a Workspace owner/admin (`role`), so an admin can
 * clean up after an Agent archived on another member's Computer. Only an archived Agent's
 * workspace opens up this way; a live Agent's stays its Computer owner's
 * (`ownedComputerAgentAssignment`).
 */
export async function archivedAgentWorkspaceAssignment(
  db: Pick<Db, "agent">,
  viewer: WorkspaceFilesViewer & { role: string | undefined },
  agentId: string,
): Promise<WorkspaceFilesAssignment | undefined> {
  const admin = Boolean(
    viewer.role && isWorkspaceMemberRole(viewer.role) && isAdminLike(viewer.role),
  );
  const assignment = await db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId: viewer.workspaceId,
      deletedAt: { not: null },
      computer: {
        ...(admin ? {} : { ownerId: viewer.userId }),
        workspaces: { some: { workspaceId: viewer.workspaceId } },
      },
    },
    select: { computerId: true, runtimeConfig: true },
  });
  if (!assignment?.computerId) return undefined;
  return {
    computerId: assignment.computerId,
    revision: workspaceRevision(assignment.runtimeConfig),
  };
}

/** A result store for a query kind this caller never publishes. */
const UNUSED_RESULTS = {
  begin: async () => {},
  read: async () => undefined,
  clear: async () => {},
};

/**
 * The Workspace Files query the Computer page uses for one owned Computer: workspace delete
 * always, and directory listing when `list` is set (the workspace scan). File reads are never
 * published from here.
 */
export function computerWorkspaceFilesQuery(
  db: Pick<Db, "agent">,
  computerId: string,
  options: { list: boolean },
) {
  return workspaceFilesQuery(
    (viewer, agentId) => ownedComputerAgentAssignment(db, computerId, viewer, agentId),
    options,
  );
}

/** The same query for an archived Agent's profile (`archivedAgentWorkspaceAssignment`). */
export function archivedAgentWorkspaceFilesQuery(
  db: Pick<Db, "agent">,
  role: string | undefined,
  options: { list: boolean },
) {
  return workspaceFilesQuery(
    (viewer, agentId) => archivedAgentWorkspaceAssignment(db, { ...viewer, role }, agentId),
    options,
  );
}

function workspaceFilesQuery(
  findOwned: (
    viewer: WorkspaceFilesViewer,
    agentId: string,
  ) => Promise<WorkspaceFilesAssignment | undefined>,
  options: { list: boolean },
) {
  return new AgentWorkspaceFilesQuery({
    findOwned,
    online: (scope) => getComputerStatusCache().get(scope),
    publishList: options.list
      ? (request) =>
          createCentrifugoServerApi().publish(
            daemonControlChannel(request.workspaceId, request.computerId),
            encodeAgentWorkspaceFilesListRequest(request),
          )
      : async () => {},
    publishRead: async () => {},
    listResults: options.list ? getAgentWorkspaceFilesListResults() : UNUSED_RESULTS,
    readResults: UNUSED_RESULTS,
    publishDelete: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentWorkspaceDeleteRequest(request),
      ),
    deleteResults: getAgentWorkspaceDeleteResults(),
  });
}
