import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { authMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaWorkspaceAccess } from "#src/server/db/repositories/setup.repositories.server";
import {
  approveAttachSession,
  readAttachSession,
  refuseAttachSession,
} from "#src/server/computers/computer-attach.server";

/**
 * The attach approval page's server functions (task #417): a signed-in person reads the machine
 * that asked to attach, the code to compare with its CLI's, and the workspaces they may attach
 * it to (the same accessibility `computer:register` checks), then approves for one of those —
 * or refuses, which the machine's next poll answers as `access_denied`.
 */
const sessionInput = z.object({ sessionId: z.string().uuid() });
const approveInput = sessionInput.extend({ workspaceId: z.string().uuid() });

export const readComputerAttach = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(sessionInput)
  .handler(async ({ data, context }) => {
    const db = requireDatabaseClient();
    const [session, workspaces] = await Promise.all([
      readAttachSession(db, data.sessionId),
      new PrismaWorkspaceAccess(db).listAccessible({ userId: context.user.id }),
    ]);
    if (!session) return null;
    return {
      machineName: session.machineName,
      hostname: session.hostname,
      os: session.os,
      userCode: session.userCode,
      workspaces: workspaces.map(({ id, slug }) => ({ id, slug })),
    };
  });

export const approveComputerAttach = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(approveInput)
  .handler(async ({ data, context }) => {
    const db = requireDatabaseClient();
    // The workspace the picker names must be one the approver may attach to — the same
    // accessibility rule `computer:register` enforces, not a second one.
    const accessible = await new PrismaWorkspaceAccess(db).findAccessibleById(data.workspaceId, {
      userId: context.user.id,
    });
    if (!accessible) return { approved: false as const };
    return {
      approved: (await approveAttachSession(db, {
        sessionId: data.sessionId,
        userId: context.user.id,
        workspaceId: data.workspaceId,
      })) as boolean,
    };
  });

export const refuseComputerAttach = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(sessionInput)
  .handler(async ({ data }) => ({
    refused: await refuseAttachSession(requireDatabaseClient(), data.sessionId),
  }));
