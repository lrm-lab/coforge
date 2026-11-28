import type { PrismaClient } from "#src/generated/prisma/client";
import { issueTerminalSubscriptionToken } from "#src/server/auth/browser-realtime-token.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  centrifugoServerApiConfigured,
  createCentrifugoServerApi,
  daemonOnline,
} from "#src/server/centrifugo/server-api.server";
import { getComputerRestartStore } from "#src/server/computers/computer-restart-store.server";
import { getComputerTerminalCapabilityLease } from "#src/server/computers/computer-terminal-capability.server";
import { getComputerTerminalStore } from "#src/server/computers/computer-terminal-store.server";
import {
  ComputerTerminalService,
  type ComputerTerminalRepository,
} from "#src/server/computers/computer-terminal.server";
import {
  createCentrifugoTerminalControlPublisher,
  revokeComputerTerminalScope,
  revokeComputerTerminalWhenDaemonReplaced,
  revokeUserTerminalSessionAttachments,
  type TerminalRevocationPorts,
} from "#src/server/computers/computer-terminal-revocation.server";

export function prismaComputerTerminalRepository(db: PrismaClient): ComputerTerminalRepository {
  return {
    async findComputer({ workspaceId, computerId, userId }) {
      const row = await db.workspaceComputer.findUnique({
        where: { workspaceId_computerId: { workspaceId, computerId } },
        select: {
          terminalEnabled: true,
          workspace: {
            select: {
              members: { where: { userId }, select: { userId: true } },
            },
          },
          computer: {
            select: {
              id: true,
              ownerId: true,
              platform: true,
              deletedAt: true,
              owner: { select: { webLoginGeneration: true } },
            },
          },
        },
      });
      if (!row || row.computer.deletedAt !== null) return undefined;
      return {
        computerId: row.computer.id,
        ownerId: row.computer.ownerId,
        isMember: row.workspace.members.length > 0,
        platform: row.computer.platform,
        terminalEnabled: row.terminalEnabled,
        ownerWebLoginGeneration: row.computer.owner.webLoginGeneration,
      };
    },
    async setTerminalEnabled({ workspaceId, computerId }, enabled) {
      await db.workspaceComputer.update({
        where: { workspaceId_computerId: { workspaceId, computerId } },
        data: { terminalEnabled: enabled },
      });
    },
  };
}

function createRevocationPorts(): TerminalRevocationPorts {
  const api = () => createCentrifugoServerApi();
  return {
    store: getComputerTerminalStore(),
    publishControl: createCentrifugoTerminalControlPublisher((channel, bytes, options) =>
      api().publish(channel, bytes, options),
    ),
    publishFrame: (channel, bytes) => api().publish(channel, bytes, { skipHistory: true }),
    unsubscribeUserChannel: (subscriptions) => api().unsubscribe(subscriptions),
  };
}

export function createProductionComputerTerminalService(db: PrismaClient): ComputerTerminalService {
  const api = () => createCentrifugoServerApi();
  const capabilityLease = getComputerTerminalCapabilityLease();
  const restartStore = getComputerRestartStore();
  const checkOnline = daemonOnline(api, getComputerStatusCache());
  return new ComputerTerminalService({
    ...createRevocationPorts(),
    repository: prismaComputerTerminalRepository(db),
    online: (scope) => checkOnline(scope),
    supportsCapability: (scope, workerInstanceId) =>
      capabilityLease.supports(scope.workspaceId, scope.computerId, workerInstanceId),
    daemonIdentity: (scope) => restartStore.identity?.(scope) ?? Promise.resolve(undefined),
    issueSubscriptionToken: (input) => issueTerminalSubscriptionToken(input),
  });
}

function terminalInfraReady(): boolean {
  return Boolean(process.env.REDIS_URL) && centrifugoServerApiConfigured();
}

export async function revokeComputerTerminalBestEffort(input: {
  workspaceId: string;
  computerId: string;
  closeShell: boolean;
  notifyReason?: "daemon_replaced" | "permission_denied";
}): Promise<void> {
  if (!terminalInfraReady()) return;
  try {
    await revokeComputerTerminalScope(createRevocationPorts(), input);
  } catch {}
}

export async function revokeComputerTerminalOnDaemonReplaced(
  scope: { workspaceId: string; computerId: string },
  newWorkerInstanceId: string,
): Promise<void> {
  if (!terminalInfraReady()) return;
  try {
    await revokeComputerTerminalWhenDaemonReplaced(
      createRevocationPorts(),
      scope,
      newWorkerInstanceId,
    );
  } catch {}
}

export async function revokeUserTerminalAttachments(userId: string): Promise<void> {
  if (!terminalInfraReady()) return;
  try {
    await revokeUserTerminalSessionAttachments(createRevocationPorts(), userId);
  } catch {}
}
