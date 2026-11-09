import { createServerFn } from "@tanstack/react-start";
import {
  consumeResetCreditInputSchema,
  readResetCreditInputSchema,
  readUsageInputSchema,
  scanUsageInputSchema,
} from "./computer.schemas";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { getUsageCache } from "#src/server/centrifugo/usage-cache.server";
import {
  createCentrifugoServerApi,
  createUsageScan,
} from "#src/server/centrifugo/server-api.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { userRuntimeResetCredit } from "#src/server/computers/runtime-reset-credit-composition.server";
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

/**
 * Starts spending one reset credit of the account a runtime is signed in to, and returns at once
 * with the request to read the answer by: production closes a request idle for about ten seconds,
 * and the Computer can take longer. Stricter than `scanUsage`: only who may sign the runtime in or
 * out. A refusal comes back as a value, never thrown, so the page can tell it from a failure. The
 * fresh usage reaches the popover through the usage cache.
 */
export const consumeResetCredit = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(consumeResetCreditInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return userRuntimeResetCredit(context.db).start(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    );
  });

/** The Computer's answer to a started attempt: pending, or what it settled. Allowed to the same
 * people as the start, on every read. */
export const readResetCredit = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readResetCreditInputSchema)
  .handler(async ({ context, data }) => {
    declareNoStore();
    return userRuntimeResetCredit(context.db).read(
      { userId: context.user.id, workspaceId: context.workspaceId },
      data,
    );
  });
