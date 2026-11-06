import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { computerIdInputSchema } from "#src/features/computers/computer.schemas";
import { getComputerConnectRefusals } from "#src/server/centrifugo/computer-connect-refusals.server";
import { HostDirectoryError } from "#src/server/hosts/host-directory.server";
import { HostJobError } from "#src/server/hosts/host-jobs.server";
import {
  productionCloudComputers,
  productionCloudReconnect,
} from "#src/server/hosts/host-production.server";

export const ensureCloudComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    try {
      return await productionCloudComputers(context.db).ensureDefault({
        userId: context.user.id,
        workspaceId: context.workspaceId,
        now: new Date(),
      });
    } catch (error) {
      if (error instanceof HostDirectoryError && error.status === 503) return null;
      throw cloudError(error);
    }
  });

export const addExtraCloudComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    try {
      return await productionCloudComputers(context.db).addExtra({
        userId: context.user.id,
        workspaceId: context.workspaceId,
        now: new Date(),
      });
    } catch (error) {
      throw cloudError(error);
    }
  });

export const reconnectCloudComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(computerIdInputSchema)
  .handler(async ({ context, data }) => {
    // Only a binding the connect proxy refused for good is worth a fresh attach; a healthy one
    // keeps its credential and an attach would only mint a key nobody needs.
    const [refusal] = await getComputerConnectRefusals()
      .getMany([{ workspaceId: context.workspaceId, computerId: data.computerId }])
      .catch(() => [null]);
    if (!refusal) throw new Error("cloud computer has no connect refusal");
    try {
      return await productionCloudReconnect(context.db).reconnect({
        userId: context.user.id,
        workspaceId: context.workspaceId,
        computerId: data.computerId,
        now: new Date(),
      });
    } catch (error) {
      throw cloudError(error);
    }
  });

function cloudError(error: unknown): Error {
  if (error instanceof HostJobError || error instanceof HostDirectoryError) {
    return new Error(error.message);
  }
  if (error instanceof Error) return error;
  return new Error("cloud computer failed");
}
