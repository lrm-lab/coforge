import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { decideComputerAttachSession } from "#src/server/computers/computer-attach-session.server";
import {
  listMachineAttachRequests,
  readMachineAttachApproval,
} from "#src/server/computers/computer-attach-visibility.server";

const sessionInput = z.object({ sessionId: z.uuid() });
const decisionInput = sessionInput.extend({
  workspaceId: z.uuid(),
  userCode: z.string().trim().length(8).optional(),
  action: z.enum(["approve", "deny"]),
});

export const readMachineAttach = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(sessionInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const db = requireDatabaseClient();
    const userId = context.user.id;
    const session = await readMachineAttachApproval(db, data.sessionId, userId);
    if (!session) return null;
    const relatedRequests = session.targetWorkspaceId
      ? ((await listMachineAttachRequests(db, session.targetWorkspaceId, userId)) ?? [])
      : [];
    return { ...session, relatedRequests };
  });

export const decideMachineAttach = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(decisionInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const accepted = await decideComputerAttachSession(requireDatabaseClient(), {
      ...data,
      userId: context.user.id,
    });
    return { accepted };
  });

export const listMachineAttach = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { db, workspaceId, user } }) => {
    declareNoStore();
    return listMachineAttachRequests(db, workspaceId, user.id);
  });

export const denyMachineAttachFromList = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(sessionInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    declareNoStore();
    const accepted = await decideComputerAttachSession(db, {
      sessionId: data.sessionId,
      userId: user.id,
      workspaceId,
      action: "deny",
    });
    return { accepted };
  });
