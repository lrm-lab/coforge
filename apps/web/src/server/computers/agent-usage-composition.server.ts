import type { PrismaClient } from "#src/generated/prisma/client";
import { getAgentUsageCache } from "#src/server/centrifugo/agent-usage-cache.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { AgentUsageAccess } from "./agent-usage-access.server";
import { getAgentUsageCapabilityLease } from "./agent-usage-capability.server";
import { resolveAgentUsageTarget } from "./agent-usage-scope.server";
import { userRuntimeUsage } from "./runtime-usage-composition.server";

export function userAgentUsage(db: PrismaClient): AgentUsageAccess {
  const runtimeUsage = userRuntimeUsage(db);
  return new AgentUsageAccess({
    resolve: (principal, agentId) =>
      resolveAgentUsageTarget(db, {
        workspaceId: principal.workspaceId,
        ownerId: principal.userId,
        agentId,
      }),
    usageOffer: (principal, target) => runtimeUsage.usageOffer(principal, target),
    supportedWorker: (workspaceId, computerId) =>
      getAgentUsageCapabilityLease().supportedWorker(workspaceId, computerId),
    cache: getAgentUsageCache,
    publish: (channel, request) => createCentrifugoServerApi().publish(channel, request),
  });
}
