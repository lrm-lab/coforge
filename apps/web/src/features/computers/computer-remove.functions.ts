import { createServerFn } from "@tanstack/react-start";

import { errorType } from "#src/server/errors/error-type.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  createCentrifugoServerApi,
  reconnectDaemon,
} from "#src/server/centrifugo/server-api.server";
import { removeComputerFromWorkspace } from "#src/server/computers/computer-membership.server";
import { getWorkspaceComputerInvalidation } from "#src/server/agents/workspace-computer-invalidation.server";
import { computerIdInputSchema } from "./computer.schemas";

/** Unlinks an owner's local Computer from this Workspace while preserving its identity elsewhere. */
export const removeComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(computerIdInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    await removeComputerFromWorkspace(db, {
      userId: user.id,
      workspaceId,
      computerId: data.computerId,
    });
    getWorkspaceComputerInvalidation().notify(data.computerId);
    try {
      await reconnectDaemon(createCentrifugoServerApi(), workspaceId, data.computerId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "computer:workspace_unlink_reconnect_failed",
          workspace_id: workspaceId,
          computer_id: data.computerId,
          error_type: errorType(error),
        }),
      );
    }
    return { removed: true as const };
  });
