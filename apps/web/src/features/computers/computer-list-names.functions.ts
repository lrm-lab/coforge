import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { listedWorkspaceComputerWhere } from "#src/server/computers/computer-list-visibility.server";

/** Every Computer connected to the Workspace, by identity only: what pickers and search name. */
export const listComputerNames = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const connections = await db.workspaceComputer.findMany({
      where: { workspaceId, computer: listedWorkspaceComputerWhere(user.id) },
      select: { computer: { select: { id: true, name: true, displayName: true, kind: true } } },
      orderBy: { createdAt: "asc" },
    });
    return connections.map(({ computer }) => computer);
  });
