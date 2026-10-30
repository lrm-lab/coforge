import { createServerFn } from "@tanstack/react-start";
import { readUsageInputSchema, scanUsageInputSchema } from "./computer.schemas";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { getUsageCache } from "#src/server/centrifugo/usage-cache.server";
import {
  createCentrifugoServerApi,
  createUsageScan,
} from "#src/server/centrifugo/server-api.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";

const runtimeVisibility = (db: PrismaClient) =>
  new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));

/** Asks the Computer to scan one runtime's usage; the answer arrives through `readUsage`. */
export const scanUsage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(scanUsageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
    if (
      !(await visibility.isOwner({ workspaceId, userId: user.id }, data.computerId, data.provider))
    )
      throw new Error("runtime is not available");
    const scanId = await createUsageScan(createCentrifugoServerApi(), {
      workspaceId,
      computerId: data.computerId,
      provider: data.provider,
    });
    return { scanId, status: "pending" as const };
  });

/** The cached usage result for one runtime; readable while a scan is still running. */
export const readUsage = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readUsageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
    if (
      !(await visibility.isOwner({ workspaceId, userId: user.id }, data.computerId, data.provider))
    )
      throw new Error("runtime is not available");
    return getUsageCache().read({
      workspaceId,
      computerId: data.computerId,
      provider: data.provider,
    });
  });
