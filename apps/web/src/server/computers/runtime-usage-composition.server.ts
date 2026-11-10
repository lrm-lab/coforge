import type { PrismaClient } from "#src/generated/prisma/client";
import { getUsageCache } from "#src/server/centrifugo/usage-cache.server";
import {
  createCentrifugoServerApi,
  createUsageScan,
} from "#src/server/centrifugo/server-api.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { PrismaRuntimeAuthAuthorization } from "./runtime-auth-authorization.server";
import { RuntimeUsageAccess } from "./runtime-usage-access.server";

/**
 * The `RuntimeUsageAccess` the signed-in user's Server Functions and the Agent profile go through.
 * The cache and the Centrifugo API are opened on use, so a refused call never reaches them.
 */
export const userRuntimeUsage = (db: PrismaClient) =>
  new RuntimeUsageAccess({
    authorization: new PrismaRuntimeAuthAuthorization(db),
    runtimes: new PrismaComputerRuntimeRepository(db),
    readCache: (target) => getUsageCache().read(target),
    startScan: (target) => createUsageScan(createCentrifugoServerApi(), target),
  });
