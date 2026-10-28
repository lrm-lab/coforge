import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { listedWorkspaceComputerWhere } from "#src/server/computers/computer-list-visibility.server";

/** Minimal Computer identity and connection state used while waiting for a new installation. */
export const listComputerConnections = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    const connections = await db.workspaceComputer.findMany({
      where: { workspaceId, computer: listedWorkspaceComputerWhere(user.id) },
      select: {
        computer: {
          select: { id: true, name: true, displayName: true, kind: true, ownerId: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const online = await getComputerStatusCache().getMany(
      connections.map(({ computer }) => ({ workspaceId, computerId: computer.id })),
    );
    return connections.map(({ computer }, index) => ({
      id: computer.id,
      name: computer.name,
      displayName: computer.displayName,
      kind: computer.kind,
      ownedByCurrentUser: computer.ownerId === user.id,
      online: online[index] ?? false,
    }));
  });
