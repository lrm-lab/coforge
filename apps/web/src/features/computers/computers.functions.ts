import {
  getComputerUpgradeProgressStore,
  latestComputerUpgradeProgressIds,
  readVisibleComputerUpgradeProgress,
} from "#src/server/computers/computer-upgrade-progress-wire.server";
import { createServerFn } from "@tanstack/react-start";
import { requireRuntimeProvider, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { modelMetadata } from "#src/features/computers/computer-model-metadata";
import { machineStatusView } from "#src/features/computers/computer-machine-status";
import { readCloudComputerImages } from "#src/server/hosts/cloud-image-inventory.server";

import {
  computerIdInputSchema,
  readRestartStatusInputSchema,
  upgradeComputerInputSchema,
  scanAgentWorkspacesInputSchema,
  setRuntimeVisibilityInputSchema,
  updateComputerDisplayNameInputSchema,
} from "./computer.schemas";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getComputerConnectRefusals } from "#src/server/centrifugo/computer-connect-refusals.server";
import { readListRuntimeUsages } from "#src/server/computers/computer-list-usage.server";
import { getComputerRuntimeDetection } from "#src/server/computers/computer-runtime-detection.server";
import { computerCreatorAvatarUrl } from "#src/server/computers/computer-creator-avatar.server";
import { isWorkspaceMemberComputer } from "#src/server/computers/computer-membership.server";
import { listedWorkspaceComputerWhere } from "#src/server/computers/computer-list-visibility.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import { getComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { getComputerReleaseState } from "#src/server/computers/computer-release-state-composition.server";
import {
  agentRuntimeAuthSource,
  lazyRuntimeCredentialKeyReader,
} from "#src/server/computers/agent-shared-runtime-auth.server";
import { runtimeAuthView } from "#src/server/computers/computer-runtime-auth.server";
import { runUpgradeComputerAction } from "#src/server/computers/upgrade-computer-action.server";
import { readAgentWorkspaceScan } from "#src/server/computers/computer-workspace-scan.server";
import {
  readableRuntimeConfig,
  publicAgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import {
  agentVisibilityViewerForUser,
  visibleAgentWhere,
} from "#src/server/agents/agent-visibility.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";

function runtimeVisibility(db: WorkspaceUserContext["db"]) {
  const control = new AgentControl(
    new PrismaAgentControlStore(db),
    createCentrifugoServerApi(),
    getAgentRuntimeLock(),
  );
  return new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db), control);
}

export { listComputerNames } from "./computer-list-names.functions";
export { deleteComputer, formatCloudComputer } from "./computer-lifecycle.functions";

export const listComputers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
    const computerStatus = getComputerStatusCache();
    const agentViewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    const canManage = agentViewer.role === "owner" || agentViewer.role === "admin";
    const [connections, runtimes] = await Promise.all([
      db.workspaceComputer.findMany({
        where: { workspaceId, computer: listedWorkspaceComputerWhere(user.id) },
        select: {
          id: true,
          createdAt: true,
          computer: {
            select: {
              id: true,
              name: true,
              displayName: true,
              kind: true,
              cloudSlot: true,
              ownerId: true,
              computerVersion: true,
              platform: true,
              osVersion: true,
              runtimeAuth: true,
              diskAvailableBytes: true,
              diskTotalBytes: true,
              diskReportedAt: true,
              memoryAvailableBytes: true,
              memoryTotalBytes: true,
              memoryReportedAt: true,
              owner: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  avatarObjectKey: true,
                },
              },
              agents: {
                where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...visibleAgentWhere(agentViewer) },
                select: {
                  id: true,
                  name: true,
                  displayName: true,
                  avatarMascot: true,
                  ownerId: true,
                  stoppedAt: true,
                  runtimeConfig: true,
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      visibility.list({ workspaceId, userId: user.id }),
    ]);
    const computerScopes = connections.map(({ computer }) => ({
      workspaceId,
      computerId: computer.id,
    }));
    const agentScopes = connections.flatMap(({ computer }) =>
      computer.agents.map((agent) => ({ workspaceId, computerId: computer.id, agentId: agent.id })),
    );
    const cloudIds = connections
      .filter(({ computer }) => computer.kind === "cloud")
      .map(({ computer }) => computer.id);
    const runtimeDetection = getComputerRuntimeDetection();
    const [
      statuses,
      agentDisplays,
      detecting,
      upgrades,
      images,
      refusals,
      releaseChannels,
      progressIds,
      usageByComputer,
    ] = await Promise.all([
      computerStatus.getMany(computerScopes),
      getAgentDisplay().snapshotMany(agentScopes),
      Promise.all(
        computerScopes.map((scope) => runtimeDetection.detecting(scope).catch(() => false)),
      ),
      getComputerUpgradeStore()
        .latestMany(computerScopes)
        .catch(() => []),
      readCloudComputerImages(cloudIds),
      getComputerConnectRefusals()
        .getMany(computerScopes)
        .catch(() => computerScopes.map(() => null)),
      getComputerReleaseState()
        .getMany(computerScopes)
        .catch(() => computerScopes.map(() => undefined)),
      latestComputerUpgradeProgressIds(
        connections
          .filter(({ computer }) => computer.kind === "local" && computer.ownerId === user.id)
          .map(({ id }) => id),
      ).catch(() => new Map<string, string>()),
      readListRuntimeUsages({
        workspaceId,
        userId: user.id,
        canManage,
        computers: connections.map(({ computer }) => computer),
        runtimes,
      }),
    ]);
    const progressToVerify = connections.flatMap(({ id: bindingId, computer }, index) => {
      const requestId = progressIds.get(bindingId);
      const stored = upgrades[index];
      return requestId &&
        (!stored || (stored.status === "failed" && stored.requestId === requestId))
        ? [{ bindingId, computerId: computer.id, requestId }]
        : [];
    });
    if (progressToVerify.length) {
      const recoverableProgress = await getComputerUpgradeProgressStore()
        .hasEvidenceMany(progressToVerify)
        .catch(() => []);
      progressToVerify.forEach(({ bindingId }, index) => {
        if (!recoverableProgress[index]) progressIds.delete(bindingId);
      });
    }
    const agentDisplayById = new Map(
      agentScopes.map((scope, index) => [scope.agentId, agentDisplays[index]] as const),
    );
    const readCredentialKey = lazyRuntimeCredentialKeyReader();
    return Promise.all(
      connections.map(async ({ id: bindingId, computer, createdAt }, index) => {
        const computerRuntimes = runtimes.filter((runtime) => runtime.computerId === computer.id);
        const agents = await Promise.all(
          computer.agents.map(async (agent) => {
            const config = readableRuntimeConfig(agent.runtimeConfig, agent.id);
            const runtimeAuthSource = await agentRuntimeAuthSource(
              agent.id,
              config,
              readCredentialKey,
            );
            return {
              id: agent.id,
              name: agent.name,
              displayName: agent.displayName,
              avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
              ownedByCurrentUser: agent.ownerId === user.id,
              stopped: agent.stoppedAt !== null,
              hasApiKey: config?.provider.kind === "coforge" && Boolean(config.provider.apiKey),
              provider: config?.runtime,
              runtimeAuthSource,
              runtimeConfig: config ? publicAgentRuntimeConfig(config) : undefined,
              runtimeConfigInvalid: agent.runtimeConfig != null && !config,
              display: agentDisplayById.get(agent.id),
            };
          }),
        );
        return {
          id: computer.id,
          name: computer.name,
          displayName: computer.displayName,
          kind: computer.kind,
          cloudSlot: computer.cloudSlot,
          imageVersion: images.get(computer.id)?.version ?? null,
          imageUpdate: images.get(computer.id)?.update ?? null,
          upgrade: upgrades[index] ?? null,
          upgradeProgressRequestId: progressIds.get(bindingId),
          computerVersion: computer.computerVersion,
          platform: computer.platform,
          osVersion: computer.osVersion,
          machine: machineStatusView(computer),
          creator: {
            username: computer.owner.username,
            displayName: computer.owner.displayName,
            avatarUrl: computerCreatorAvatarUrl(computer.id, workspaceId, computer.owner),
          },
          connectedAt: createdAt,
          ownedByCurrentUser: computer.ownerId === user.id,
          canManageAgents: canManage,
          // The account and plan only for whoever may sign the runtimes in or out (task #94).
          runtimeAuth: runtimeAuthView(computer.runtimeAuth, {
            showAccount: computer.ownerId === user.id || canManage,
            runtimes: computerRuntimes,
          }),
          runtimeUsages: usageByComputer.get(computer.id) ?? {},
          online: statuses[index] ?? false,
          connectRefusal: refusals[index] ?? null,
          releaseChannel: releaseChannels[index],
          runtimeDetecting: detecting[index] ?? false,
          agents,
          runtimes: computerRuntimes.map(({ ownerId: _ownerId, ...runtime }) => runtime),
        };
      }),
    );
  });

/** A Computer owner can ask the connected Daemon for a fresh local workspace inventory. */
export const scanAgentWorkspaces = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(scanAgentWorkspacesInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    declareNoStore();
    return readAgentWorkspaceScan(
      db,
      { userId: user.id, workspaceId, computerId: data.computerId },
      false,
    );
  });

/** The budgeted file counts and sizes for that same inventory. It never blocks the listing: the
 * page renders the rows first and merges these in when they arrive. */
export const scanAgentWorkspaceStats = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(scanAgentWorkspacesInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    declareNoStore();
    return readAgentWorkspaceScan(
      db,
      { userId: user.id, workspaceId, computerId: data.computerId },
      true,
    );
  });

export const readComputerUpgradeStatus = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readRestartStatusInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const scope = { workspaceId, computerId: data.computerId };
    if (!(await isWorkspaceMemberComputer(db, { userId: user.id, ...scope })))
      throw new Error("Computer is not available");
    const status = await getComputerUpgradeStore().status(scope, data.requestId);
    const terminalStatus =
      status?.status === "completed" || status?.status === "failed"
        ? status.status
        : status
          ? undefined
          : null;
    const progressRead = readVisibleComputerUpgradeProgress(
      db,
      { ...scope, userId: user.id },
      data.requestId,
      terminalStatus,
    );
    const progress = status ? await progressRead.catch(() => undefined) : await progressRead;
    if (!status && !progress) return { requestId: data.requestId, status: "not_found" } as const;
    return {
      ...(status ?? ({ requestId: data.requestId, status: "unknown", reason: "corrupt" } as const)),
      ...(progress ? { progress } : {}),
    };
  });

export const upgradeComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(upgradeComputerInputSchema)
  .handler(async ({ context, data }) => runUpgradeComputerAction(context, data));

export const getComputerRuntimeCatalog = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(computerIdInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
    const [connection, runtimes] = await Promise.all([
      db.workspaceComputer.findUnique({
        where: {
          workspaceId_computerId: { workspaceId, computerId: data.computerId },
        },
        select: {
          computer: {
            select: {
              modelCatalogs: {
                where: { workspaceId },
                select: { provider: true, models: true, observedAt: true },
                orderBy: { provider: "asc" },
              },
            },
          },
        },
      }),
      visibility.list({ workspaceId, userId: user.id }),
    ]);
    if (!connection) throw new Error("Computer is not available");
    const visibleProviders = new Set(
      runtimes
        .filter((runtime) => runtime.computerId === data.computerId)
        .map((runtime) => runtime.provider),
    );
    return connection.computer.modelCatalogs
      .filter((catalog) => visibleProviders.has(runtimeProvider(catalog.provider)))
      .map((catalog) => ({
        provider: runtimeProvider(catalog.provider),
        models: modelMetadata(catalog.models),
        observedAt: catalog.observedAt,
      }))
      .filter((catalog) => catalog.models !== undefined)
      .map((catalog) => ({ ...catalog, models: catalog.models! }));
  });

export const setRuntimeVisibility = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(setRuntimeVisibilityInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
    return visibility.setPublic({ workspaceId, userId: user.id }, data.runtimeId, data.isPublic);
  });

export const updateComputerDisplayName = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(updateComputerDisplayNameInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const result = await db.computer.updateMany({
      where: {
        id: data.computerId,
        ownerId: user.id,
        workspaces: { some: { workspaceId } },
      },
      data: { displayName: data.displayName },
    });
    if (result.count !== 1) throw new Error("Computer is not available");
    return { displayName: data.displayName };
  });

function runtimeProvider(value: string): RuntimeProvider {
  return requireRuntimeProvider(value, "Computer reported an unknown runtime provider");
}
