import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { readOwnedInstallerRecovery } from "#src/server/computers/computer-installer-recovery-view.server";

export const readComputerInstallerRecovery = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ computerId: z.uuid() }))
  .handler(({ data, context: { db, workspaceId, user } }) => {
    setResponseHeader("Cache-Control", "no-store");
    return readOwnedInstallerRecovery(db, {
      workspaceId,
      computerId: data.computerId,
      userId: user.id,
    });
  });
