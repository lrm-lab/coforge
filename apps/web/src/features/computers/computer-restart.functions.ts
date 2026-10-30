import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { isWorkspaceMemberComputer } from "#src/server/computers/computer-membership.server";
import { getComputerRestartStore } from "#src/server/computers/computer-restart-store.server";
import { RestartComputer } from "#src/server/computers/restart-computer.server";
import { readRestartStatusInputSchema, restartComputerInputSchema } from "./computer.schemas";

/** A Computer's restart: asking for one, and reading how it went. */
export const restartComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(restartComputerInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new RestartComputer(
      {
        canRestart: (scope) => isWorkspaceMemberComputer(db, scope),
      },
      createCentrifugoServerApi(),
      getComputerRestartStore(),
    ).execute({ userId: user.id, workspaceId }, data);
  });

export const readComputerRestartStatus = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readRestartStatusInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const scope = { workspaceId, computerId: data.computerId };
    if (!(await isWorkspaceMemberComputer(db, { userId: user.id, ...scope })))
      throw new Error("Computer is not available");
    const status = await getComputerRestartStore().status(scope, data.requestId);
    if (!status) throw new Error("Restart request is not available");
    return status;
  });
