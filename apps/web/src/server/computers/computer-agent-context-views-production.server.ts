import { encodeAgentContextViewRequest } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getAgentContextViewResults } from "#src/server/centrifugo/agent-context-view-results.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  daemonOnline,
} from "#src/server/centrifugo/server-api.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { getAgentContextViewAvailabilityStore } from "#src/server/centrifugo/agent-context-view-availability-receiver.server";
import { getAgentContextViewCapabilityLease } from "./agent-context-view-capability.server";
import { ComputerAgentContextViews } from "./computer-agent-context-views.server";
import {
  agentVisibilityViewerForUser,
  canSeeAgent,
} from "#src/server/agents/agent-visibility.server";
import { isElevatedServerRole } from "#src/server/workspaces/member-role.server";

/** Production owner-gated composition for Agent context view requests. */
export function computerAgentContextViews(
  db: Pick<PrismaClient, "computer" | "agent" | "workspaceMembership">,
) {
  return new ComputerAgentContextViews({
    enabled: (viewer) => isFeatureEnabled("agentContextView", { workspaceId: viewer.workspaceId }),
    visible: async (viewer, agentId) => {
      const visibilityViewer = await agentVisibilityViewerForUser(
        db,
        viewer.workspaceId,
        viewer.userId,
      );
      const agent = await db.agent.findFirst({
        where: { id: agentId, workspaceId: viewer.workspaceId, deletedAt: null },
        select: { visibility: true, ownerId: true, systemKind: true },
      });
      return Boolean(agent && canSeeAgent(visibilityViewer, agent));
    },
    owned: async (viewer, computerId) => {
      const membership = await db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: viewer.workspaceId, userId: viewer.userId } },
        select: { role: true },
      });
      return Boolean(
        await db.computer.findFirst({
          where: {
            id: computerId,
            kind: "local",
            deletedAt: null,
            workspaces: { some: { workspaceId: viewer.workspaceId } },
            ...(isElevatedServerRole(membership?.role) ? {} : { ownerId: viewer.userId }),
          },
          select: { id: true },
        }),
      );
    },
    online: daemonOnline(() => createCentrifugoServerApi(), getComputerStatusCache()),
    supported: async ({ userId, workspaceId, computerId, agentId }) => {
      const viewer = await agentVisibilityViewerForUser(db, workspaceId, userId);
      const agent = await db.agent.findFirst({
        where: {
          id: agentId,
          workspaceId,
          computerId,
          deletedAt: null,
        },
        select: { id: true, visibility: true, ownerId: true, systemKind: true },
      });
      // The Web layer only has the current Agent row here; a missing session seam is no_session.
      if (!agent || !canSeeAgent(viewer, agent))
        return { supported: false, reason: "no_session" as const };
      if (!(await getAgentContextViewCapabilityLease().supports(workspaceId, computerId)))
        return { supported: false, reason: "old_daemon" as const };
      const availability = await getAgentContextViewAvailabilityStore().read(
        workspaceId,
        computerId,
        agentId,
      );
      if (!availability) return { supported: false, reason: "old_daemon" as const };
      if (!availability.supported)
        return {
          supported: false,
          reason: availability.unsupportedReason ?? ("no_session" as const),
        };
      return { supported: true };
    },
    // Made on use: reading a result needs neither the API nor its environment.
    publish: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentContextViewRequest(request),
      ),
    results: getAgentContextViewResults(),
  });
}
