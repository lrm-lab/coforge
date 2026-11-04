import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { listComputerConnections as readComputerConnections } from "#src/server/computers/computer-connections.server";

/** Minimal Computer identity and connection state used while waiting for a new installation. */
export const listComputerConnections = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { user, db, workspaceId } }) =>
    readComputerConnections(db, { workspaceId, userId: user.id }),
  );
