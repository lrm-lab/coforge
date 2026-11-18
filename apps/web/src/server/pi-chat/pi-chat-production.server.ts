import type { PrismaClient } from "#src/generated/prisma/client";
import type { PiChatScope } from "@lrm/coforge-sdk/internal/pi-chat";
import { supportsWorkbenchCodex, type PiChatCommand } from "@lrm/coforge-sdk/internal/pi-chat";
import { encodePiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { isAiWorkbenchEnabled } from "./ai-workbench.server";
import { PiChatGateway } from "./pi-chat-gateway.server";
import { RedisPiChatResults } from "./pi-chat-results.server";
import {
  getPiChatCapabilityLease,
  getPiChatControlsLease,
  getPiChatFilesLease,
  getWorkbenchCodexLease,
} from "./pi-chat-capability.server";

export function piChatConfiguration() {
  return !!(
    Bun.env.COFORGE_CENTRIFUGO_API_URL &&
    Bun.env.COFORGE_CENTRIFUGO_API_KEY &&
    Bun.env.REDIS_URL
  );
}
export async function canUsePiChat(db: PrismaClient, scope: PiChatScope) {
  return !!(await workbenchComputer(db, scope));
}

async function workbenchComputer(db: PrismaClient, scope: PiChatScope) {
  if (!(await isAiWorkbenchEnabled(db, scope.workspaceId))) return false as const;
  return (
    (await db.computer.findFirst({
      where: {
        id: scope.computerId,
        ownerId: scope.userId,
        deletedAt: null,
        workspaces: {
          some: {
            workspaceId: scope.workspaceId,
            workspace: { members: { some: { userId: scope.userId } } },
          },
        },
      },
      select: { kind: true },
    })) ?? false
  );
}
let results: RedisPiChatResults | undefined;
export function getPiChatResults() {
  return (results ??= new RedisPiChatResults(openRedisClient(redisUrlFor("Pi chat RPC results"))));
}
export function productionPiChat(db: PrismaClient) {
  const api = createCentrifugoServerApi();
  return new PiChatGateway({
    canUse: (scope) => workbenchComputer(db, scope),
    online: async (scope, command, access) => {
      if (access === true) return false;
      const requirements = workbenchRequirements(access.kind, command);
      if (!requirements) return false;
      if (requirements.codex && command.action === "start") {
        const runtime = await db.computerRuntime.findUnique({
          where: {
            workspaceId_computerId_provider: {
              workspaceId: scope.workspaceId,
              computerId: scope.computerId,
              provider: "codex",
            },
          },
          select: { unavailableCode: true, version: true },
        });
        if (!runtime || runtime.unavailableCode || !supportsWorkbenchCodex(runtime.version))
          return false;
      }
      const leases = [
        getPiChatCapabilityLease(),
        ...(requirements.codex ? [getWorkbenchCodexLease()] : []),
        ...(requirements.files ? [getPiChatFilesLease()] : []),
        ...(requirements.controls ? [getPiChatControlsLease()] : []),
      ];
      const supported = await Promise.all(
        leases.map((lease) => lease.supports(scope.workspaceId, scope.computerId)),
      );
      return (
        supported.every(Boolean) &&
        (await api.presence(daemonControlChannel(scope.workspaceId, scope.computerId))).length > 0
      );
    },
    publish: (request) =>
      api.publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodePiChatRequest(request),
      ),
    results: getPiChatResults(),
  });
}

export function workbenchRequirements(computerKind: string, command: PiChatCommand) {
  const codex = command.runtime === "codex";
  const files =
    command.action === "files" || command.action === "file" || command.action === "upload";
  const piControls =
    command.action === "models" ||
    command.action === "take_queue" ||
    (command.action === "start" && Boolean(command.mode || command.model));
  if (
    (computerKind !== "cloud" && !codex) ||
    (codex && (files || piControls)) ||
    (!codex && command.action === "approval")
  )
    return undefined;
  return {
    codex,
    files,
    controls: !codex && (piControls || (command.action === "delete" && !!command.stop)),
  };
}
