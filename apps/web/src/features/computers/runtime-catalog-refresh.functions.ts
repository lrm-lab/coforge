import { createServerFn } from "@tanstack/react-start";
import { encodeDaemonRuntimeProviderModelRefreshRequest } from "@lrm/coforge-sdk/internal";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { getModelCatalogRefreshResults } from "#src/server/centrifugo/model-catalog-refresh-cache.server";
import { ComputerModelCatalogRefresh } from "#src/server/computers/computer-model-catalog-refresh.server";
import { getComputerRuntimeDetection } from "#src/server/computers/computer-runtime-detection.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import {
  readRuntimeCatalogRefreshInputSchema,
  startRuntimeCatalogRefreshInputSchema,
} from "./computer.schemas";

/** The refresh both Server Functions go through. Only this Workspace's Computer and the runtimes
 * the viewer may see are returned, as ordinary catalog reads do. */
function runtimeCatalogRefresh(db: PrismaClient) {
  const visibility = new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
  return new ComputerModelCatalogRefresh({
    results: getModelCatalogRefreshResults(),
    detection: getComputerRuntimeDetection(),
    authorize: async ({ workspaceId }, computerId) =>
      (await db.workspaceComputer.findUnique({
        where: { workspaceId_computerId: { workspaceId, computerId } },
        select: { computerId: true },
      })) !== null,
    visibleProviders: async ({ userId, workspaceId }, computerId) =>
      new Set(
        (await visibility.list({ workspaceId, userId }, [computerId])).map(
          (runtime) => runtime.provider,
        ),
      ),
    // Made on use: reading an answer needs neither the API nor its environment.
    publish: async (request) => {
      await createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeDaemonRuntimeProviderModelRefreshRequest(request),
      );
    },
  });
}

/**
 * Asks the Computer to re-probe its runtimes, one provider or all of them, and returns at once with
 * the request to poll: production closes a request idle for about ten seconds and a whole-Computer
 * rescan can take longer. The outcome is read with `readRuntimeCatalogRefresh`.
 */
export const startRuntimeCatalogRefresh = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(startRuntimeCatalogRefreshInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return runtimeCatalogRefresh(context.db).start(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    );
  });

/** The Computer's answer to a started refresh: pending, the outcome per provider, or a refusal. */
export const readRuntimeCatalogRefresh = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readRuntimeCatalogRefreshInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return runtimeCatalogRefresh(context.db).read(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    );
  });
