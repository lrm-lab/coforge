import { createServerFn } from "@tanstack/react-start";
import {
  encodeDaemonRuntimeProviderModelRefreshRequest,
  requireRuntimeProvider,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { modelMetadata } from "#src/features/computers/computer-model-metadata";
import { machineStatusView } from "#src/features/computers/computer-machine-status";
import { readCloudComputerImages } from "#src/server/hosts/cloud-image-inventory.server";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import { HostDirectoryError } from "#src/server/hosts/host-directory.server";
import { HostJobError } from "#src/server/hosts/host-jobs.server";

import {
  computerIdInputSchema,
  refreshRuntimeCatalogInputSchema,
  readRestartStatusInputSchema,
  upgradeComputerInputSchema,
  scanAgentWorkspacesInputSchema,
  deleteAgentWorkspaceInputSchema,
  setRuntimeVisibilityInputSchema,
  updateComputerDisplayNameInputSchema,
  formatCloudComputerInputSchema,
  computerRecoverySchema,
} from "./computer.schemas";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  reconnectDaemon,
} from "#src/server/centrifugo/server-api.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getModelCatalogRefreshResults } from "#src/server/centrifugo/model-catalog-refresh-cache.server";
import {
  ComputerModelCatalogRefresh,
  refreshOutcomeFor,
} from "#src/server/computers/computer-model-catalog-refresh.server";
import { getComputerRuntimeDetection } from "#src/server/computers/computer-runtime-detection.server";
import { computerCreatorAvatarUrl } from "#src/server/computers/computer-creator-avatar.server";
import { isWorkspaceMemberComputer } from "#src/server/computers/computer-membership.server";
import { listedWorkspaceComputerWhere } from "#src/server/computers/computer-list-visibility.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { getComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { runtimeAuthView } from "#src/server/computers/computer-runtime-auth.server";
import { runUpgradeComputerAction } from "#src/server/computers/upgrade-computer-action.server";
import {
  computerWorkspaceFilesQuery,
  findOwnedWorkspaceComputer,
} from "#src/server/computers/computer-workspace-files.server";
import { scanComputerAgentWorkspaces as scanWorkspaceInventory } from "#src/server/computers/computer-agent-workspaces.server";
import {
  parseAgentRuntimeConfig,
  publicAgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import {
  agentVisibilityViewerForUser,
  visibleAgentWhere,
} from "#src/server/agents/agent-visibility.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";

function runtimeVisibility(db: WorkspaceUserContext["db"]) {
  return new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
}

export { listComputerNames } from "./computer-list-names.functions";

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
              lastRecovery: true,
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
    // Each read needs only the connections, so they run side by side.
    const [statuses, agentDisplays, detecting, upgrades, images] = await Promise.all([
      // One round trip for every Computer's online lease, not one per Computer.
      computerStatus.getMany(computerScopes),
      getAgentDisplay().snapshotMany(agentScopes),
      Promise.all(
        computerScopes.map((scope) => runtimeDetection.detecting(scope).catch(() => false)),
      ),
      // Each Computer's latest upgrade, so a reload resumes one still running, and keeps the
      // reason one failed, instead of offering Upgrade again.
      getComputerUpgradeStore()
        .latestMany(computerScopes)
        .catch(() => []),
      readCloudComputerImages(cloudIds),
    ]);
    const agentDisplayById = new Map(
      agentScopes.map((scope, index) => [scope.agentId, agentDisplays[index]] as const),
    );
    return Promise.all(
      connections.map(async ({ computer, createdAt }, index) => {
        const computerRuntimes = runtimes.filter((runtime) => runtime.computerId === computer.id);
        return {
          id: computer.id,
          name: computer.name,
          displayName: computer.displayName,
          kind: computer.kind,
          cloudSlot: computer.cloudSlot,
          imageVersion: images.get(computer.id)?.version ?? null,
          imageUpdate: images.get(computer.id)?.update ?? null,
          upgrade: upgrades[index] ?? null,
          lastRecovery: computerRecoverySchema.safeParse(computer.lastRecovery).data ?? null,
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
          online: statuses[index] ?? false,
          runtimeDetecting: detecting[index] ?? false,
          agents: computer.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            displayName: agent.displayName,
            avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
            provider: parseAgentRuntimeConfig(agent.runtimeConfig).runtime,
            runtimeConfig: publicAgentRuntimeConfig(parseAgentRuntimeConfig(agent.runtimeConfig)),
            display: agentDisplayById.get(agent.id),
          })),
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
    const computer = await findOwnedWorkspaceComputer(db, {
      userId: user.id,
      workspaceId,
      computerId: data.computerId,
    });

    const agents = await db.agent.findMany({
      where: { workspaceId, computerId: computer.id },
      select: { id: true, name: true, displayName: true, deletedAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const query = computerWorkspaceFilesQuery(db, computer.id, { list: true });
    const inventory = await scanWorkspaceInventory(agents, async (request) => {
      const response = await query.list(
        { userId: user.id, workspaceId },
        request.agentId,
        request.dirPath,
        request.includeHidden,
      );
      if (response.status !== "ready")
        return {
          status: response.status === "offline" ? "unreadable" : "error",
          rootPath: "",
          entries: [],
        };
      return response.result;
    });
    return inventory;
  });

/** Computer owners may remove an Agent workspace's local contents. The Agent row is retained;
 * deleted Agents remain eligible so their retained workspaces can be cleaned up. */
export const deleteAgentWorkspace = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(deleteAgentWorkspaceInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    declareNoStore();
    const computer = await findOwnedWorkspaceComputer(db, {
      userId: user.id,
      workspaceId,
      computerId: data.computerId,
    });
    const query = computerWorkspaceFilesQuery(db, computer.id, { list: false });
    const response = await query.delete({ userId: user.id, workspaceId }, data.agentId);
    if (response.status !== "ready") return response;
    return response.result;
  });

export const readComputerUpgradeStatus = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readRestartStatusInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const scope = { workspaceId, computerId: data.computerId };
    if (!(await isWorkspaceMemberComputer(db, { userId: user.id, ...scope })))
      throw new Error("Computer is not available");
    const status = await getComputerUpgradeStore().status(scope, data.requestId);
    if (!status) throw new Error("Upgrade request is not available");
    return status;
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

/** Explicitly probes the Computer and waits for this request's terminal response. Like ordinary
 * catalog reads, only this Workspace's Computer and visible runtimes may be returned. */
export const refreshComputerRuntimeCatalog = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(refreshRuntimeCatalogInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    declareNoStore();
    const connection = await db.workspaceComputer.findUnique({
      where: { workspaceId_computerId: { workspaceId, computerId: data.computerId } },
      select: { computerId: true },
    });
    if (!connection) throw new Error("Computer is not available");
    const api = createCentrifugoServerApi();
    const refreshed = await new ComputerModelCatalogRefresh({
      results: getModelCatalogRefreshResults(),
      detection: getComputerRuntimeDetection(),
      publish: (request) =>
        api.publish(
          daemonControlChannel(workspaceId, data.computerId),
          encodeDaemonRuntimeProviderModelRefreshRequest(request),
        ),
    }).execute({ userId: user.id, workspaceId }, data.computerId, data.provider);
    if (refreshed.status !== "refreshed") return refreshed;
    const runtimes = await runtimeVisibility(db).list({ workspaceId, userId: user.id });
    return refreshOutcomeFor(
      refreshed.results,
      new Set(
        runtimes
          .filter((runtime) => runtime.computerId === data.computerId)
          .map((runtime) => runtime.provider),
      ),
      data.provider,
    );
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

/** Queues a disk format for the owner's cloud computer. The typed name is checked again. */
export const formatCloudComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(formatCloudComputerInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    try {
      await productionCloudComputers(db).format({
        userId: user.id,
        workspaceId,
        computerId: data.computerId,
        confirmName: data.confirmName,
        now: new Date(),
      });
    } catch (error) {
      if (error instanceof HostJobError || error instanceof HostDirectoryError) {
        throw new Error(error.message);
      }
      throw error;
    }
    return { formatted: true as const };
  });

/** Permanently removes an owner's Computer record after all of its Agents are soft-deleted. */
export const deleteComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(computerIdInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const computer = await db.computer.findFirst({
      where: {
        id: data.computerId,
        ownerId: user.id,
        workspaces: { some: { workspaceId } },
      },
      select: {
        id: true,
        kind: true,
        cloudSlot: true,
        agents: { where: { deletedAt: null }, select: { id: true }, take: 1 },
        workspaces: { select: { workspaceId: true } },
      },
    });
    if (!computer) throw new Error("Computer is not available");
    if (computer.kind === "cloud" && computer.cloudSlot === "default") {
      throw new Error("The default cloud computer cannot be deleted");
    }
    if (computer.agents.length > 0)
      throw new Error("Delete all Agents on this Computer before deleting the Computer");
    if (computer.kind === "cloud" && computer.cloudSlot === "extra") {
      try {
        await productionCloudComputers(db).deleteExtra({
          userId: user.id,
          workspaceId,
          computerId: computer.id,
          now: new Date(),
        });
      } catch (error) {
        if (error instanceof HostJobError || error instanceof HostDirectoryError) {
          throw new Error(error.message);
        }
        throw error;
      }
      return { deleted: false as const };
    }
    await db.$transaction(async (tx) => {
      for (const binding of computer.workspaces)
        await DaemonCredentialRevocations.recordForComputer(tx, {
          workspaceId: binding.workspaceId,
          computerId: computer.id,
        });
      await tx.computer.delete({ where: { id: computer.id } });
    });
    const api = createCentrifugoServerApi();
    await Promise.all(
      computer.workspaces.map(({ workspaceId: boundWorkspaceId }) =>
        reconnectDaemon(api, boundWorkspaceId, computer.id),
      ),
    );
    return { deleted: true as const };
  });

function runtimeProvider(value: string): RuntimeProvider {
  return requireRuntimeProvider(value, "Computer reported an unknown runtime provider");
}
