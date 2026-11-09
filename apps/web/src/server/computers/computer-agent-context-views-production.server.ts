import { encodeAgentContextViewRequest } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getAgentContextViewResults } from "#src/server/centrifugo/agent-context-view-results.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { getAgentContextViewAvailabilityStore } from "#src/server/centrifugo/agent-context-view-availability-receiver.server";
import { getAgentContextViewCapabilityLease } from "./agent-context-view-capability.server";
import { ComputerAgentContextViews } from "./computer-agent-context-views.server";

/** Production owner-gated composition for Agent context view requests. */
export function computerAgentContextViews(db: Pick<PrismaClient, "computer" | "agent">) {
  const centrifugo = createCentrifugoServerApi();
  return new ComputerAgentContextViews({
    enabled: (viewer) => isFeatureEnabled("agentContextView", { workspaceId: viewer.workspaceId }),
    owned: async (viewer, computerId) =>
      Boolean(
        await db.computer.findFirst({
          where: {
            id: computerId,
            ownerId: viewer.userId,
            kind: "local",
            deletedAt: null,
            workspaces: { some: { workspaceId: viewer.workspaceId } },
          },
          select: { id: true },
        }),
      ),
    online: (scope) => getComputerStatusCache().get(scope),
    supported: async ({ userId, workspaceId, computerId, agentId }) => {
      const agent = await db.agent.findFirst({
        where: {
          id: agentId,
          workspaceId,
          computerId,
          ownerId: userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      // The Web layer only has the current Agent row here; a missing session seam is no_session.
      if (!agent) return { supported: false, reason: "no_session" as const };
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
    publish: (request) =>
      centrifugo.publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentContextViewRequest(request),
      ),
    results: getAgentContextViewResults(),
  });
}
