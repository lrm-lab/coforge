import { encodeAgentMemoryRequest } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  daemonOnline,
} from "#src/server/centrifugo/server-api.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  getAgentMemoryCapabilityLease,
  getAgentMemoryResults,
} from "#src/server/centrifugo/agent-memory-results.server";
import { AgentMemoryManagement } from "./agent-memory-management.server";

export function personalMemoryManagement(db: PrismaClient) {
  return new AgentMemoryManagement({
    findOwned: (viewer, agentId) => findPersonalMemoryAssignment(db, viewer, agentId),
    online: daemonOnline(() => createCentrifugoServerApi(), getComputerStatusCache()),
    supported: (scope) =>
      getAgentMemoryCapabilityLease().supports(scope.workspaceId, scope.computerId),
    publish: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentMemoryRequest(request),
        { skipHistory: true },
      ),
    results: getAgentMemoryResults(),
  });
}

export async function findPersonalMemoryAssignment(
  db: PrismaClient,
  viewer: { workspaceId: string; userId: string },
  agentId: string,
) {
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      workspaceId: viewer.workspaceId,
      ownerId: viewer.userId,
      deletedAt: null,
      workspace: { members: { some: { userId: viewer.userId } } },
      computer: { deletedAt: null, workspaces: { some: { workspaceId: viewer.workspaceId } } },
    },
    select: { computerId: true, runtimeConfig: true },
  });
  return agent?.computerId
    ? {
        computerId: agent.computerId,
        revision: new Bun.CryptoHasher("sha256")
          .update(JSON.stringify(agent.runtimeConfig))
          .digest("hex"),
      }
    : undefined;
}
