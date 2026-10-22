import type { PrismaClient } from "#src/generated/prisma/client";
import type { PiChatScope } from "@lrm/coforge-sdk/internal/pi-chat";
import { encodePiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { PiChatGateway } from "./pi-chat-gateway.server";
import { RedisPiChatResults } from "./pi-chat-results.server";
import { getPiChatCapabilityLease } from "./pi-chat-capability.server";

export function piChatConfiguration() {
  return !!(
    Bun.env.COFORGE_CENTRIFUGO_API_URL &&
    Bun.env.COFORGE_CENTRIFUGO_API_KEY &&
    Bun.env.REDIS_URL
  );
}
export async function canUsePiChat(db: PrismaClient, scope: PiChatScope) {
  return !!(await db.computer.findFirst({
    where: {
      id: scope.computerId,
      ownerId: scope.userId,
      kind: "cloud",
      deletedAt: null,
      workspaces: {
        some: {
          workspaceId: scope.workspaceId,
          workspace: { members: { some: { userId: scope.userId } } },
        },
      },
    },
    select: { id: true },
  }));
}
let results: RedisPiChatResults | undefined;
export function getPiChatResults() {
  return (results ??= new RedisPiChatResults(openRedisClient(redisUrlFor("Pi chat RPC results"))));
}
export function productionPiChat(db: PrismaClient) {
  const api = createCentrifugoServerApi();
  return new PiChatGateway({
    canUse: (scope) => canUsePiChat(db, scope),
    online: async (scope) =>
      (await getPiChatCapabilityLease().supports(scope.workspaceId, scope.computerId)) &&
      (await api.presence(daemonControlChannel(scope.workspaceId, scope.computerId))).length > 0,
    publish: (request) =>
      api.publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodePiChatRequest(request),
      ),
    results: getPiChatResults(),
  });
}
