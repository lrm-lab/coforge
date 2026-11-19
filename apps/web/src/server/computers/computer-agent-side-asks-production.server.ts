import {
  AGENT_SIDE_ASK_ASKER_NAME_MAX_CHARS,
  encodeAgentSideAskRequest,
  type AgentSideAskAskerRole,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  agentVisibilityViewerForUser,
  canSeeAgent,
} from "#src/server/agents/agent-visibility.server";
import { getAgentSideAskResults } from "#src/server/centrifugo/agent-side-ask-results.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  daemonOnline,
} from "#src/server/centrifugo/server-api.server";
import { getAgentSideAskCapabilityLease } from "./agent-side-ask-capability.server";
import { ComputerAgentSideAsks } from "./computer-agent-side-asks.server";

function normalizeAskerRole(role: string | undefined): AgentSideAskAskerRole {
  if (role === "owner" || role === "admin") return role;
  return "member";
}

function normalizeDisplayName(raw: string | undefined): string {
  const cleaned = (raw ?? "").replaceAll("\0", "").trim();
  if (!cleaned) return "Workspace member";
  if (cleaned.length <= AGENT_SIDE_ASK_ASKER_NAME_MAX_CHARS) return cleaned;
  let cut = AGENT_SIDE_ASK_ASKER_NAME_MAX_CHARS;
  const lastCode = cleaned.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
  return cleaned.slice(0, cut).trim() || "Workspace member";
}

export function computerAgentSideAsks(
  db: Pick<PrismaClient, "agent" | "workspaceMembership" | "user">,
) {
  return new ComputerAgentSideAsks({
    resolveTarget: async (viewer, agentId) => {
      const [visibilityViewer, agent, user] = await Promise.all([
        agentVisibilityViewerForUser(db, viewer.workspaceId, viewer.userId),
        db.agent.findFirst({
          where: { id: agentId, workspaceId: viewer.workspaceId, deletedAt: null },
          select: {
            id: true,
            visibility: true,
            ownerId: true,
            systemKind: true,
            computerId: true,
            computer: {
              select: {
                id: true,
                deletedAt: true,
                workspaces: {
                  where: { workspaceId: viewer.workspaceId },
                  select: { workspaceId: true },
                  take: 1,
                },
              },
            },
          },
        }),
        db.user.findUnique({
          where: { id: viewer.userId },
          select: { displayName: true },
        }),
      ]);
      if (!agent || !visibilityViewer.role || !canSeeAgent(visibilityViewer, agent))
        return undefined;
      const computerId =
        agent.computerId &&
        agent.computer &&
        agent.computer.deletedAt === null &&
        agent.computer.workspaces.length > 0
          ? agent.computerId
          : null;
      return {
        computerId,
        asker: {
          userId: viewer.userId,
          displayName: normalizeDisplayName(user?.displayName),
          role: normalizeAskerRole(visibilityViewer.role),
          isAgentOwner: agent.ownerId === viewer.userId,
        },
      };
    },
    visible: async (viewer, agentId) => {
      const [visibilityViewer, agent] = await Promise.all([
        agentVisibilityViewerForUser(db, viewer.workspaceId, viewer.userId),
        db.agent.findFirst({
          where: { id: agentId, workspaceId: viewer.workspaceId, deletedAt: null },
          select: { visibility: true, ownerId: true, systemKind: true },
        }),
      ]);
      return Boolean(agent && visibilityViewer.role && canSeeAgent(visibilityViewer, agent));
    },
    online: (scope) =>
      daemonOnline(() => createCentrifugoServerApi(), getComputerStatusCache())(scope),
    supported: ({ workspaceId, computerId }) =>
      getAgentSideAskCapabilityLease().supports(workspaceId, computerId),
    publish: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentSideAskRequest(request),
      ),
    results: {
      begin: (pending) => getAgentSideAskResults().begin(pending),
      read: (requestId) => getAgentSideAskResults().read(requestId),
      clear: (requestId) => getAgentSideAskResults().clear(requestId),
    },
  });
}
