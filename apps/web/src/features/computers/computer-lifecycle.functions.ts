import { createServerFn } from "@tanstack/react-start";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  createCentrifugoServerApi,
  reconnectDaemon,
} from "#src/server/centrifugo/server-api.server";
import { getWorkspaceComputerInvalidation } from "#src/server/agents/workspace-computer-invalidation.server";
import { revokeComputerTerminalBestEffort } from "#src/server/computers/computer-terminal-production.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { HostDirectoryError } from "#src/server/hosts/host-directory.server";
import { HostJobError } from "#src/server/hosts/host-jobs.server";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import { computerIdInputSchema, formatCloudComputerInputSchema } from "./computer.schemas";

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
      getWorkspaceComputerInvalidation().notify(computer.id);
      return { deleted: false as const };
    }
    await db.$transaction(async (tx) => {
      await DaemonCredentialRevocations.recordForComputerWorkspaces(tx, {
        workspaceIds: computer.workspaces.map((binding) => binding.workspaceId),
        computerId: computer.id,
      });
      await tx.computer.delete({ where: { id: computer.id } });
    });
    const api = createCentrifugoServerApi();
    getWorkspaceComputerInvalidation().notify(computer.id);
    await Promise.all(
      computer.workspaces.map(async ({ workspaceId: boundWorkspaceId }) => {
        await revokeComputerTerminalBestEffort({
          workspaceId: boundWorkspaceId,
          computerId: computer.id,
          closeShell: true,
        });
        await reconnectDaemon(api, boundWorkspaceId, computer.id);
      }),
    );
    return { deleted: true as const };
  });
